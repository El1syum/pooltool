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
scoped `match-hud.css` plus `match-design.css`. Assisted-shot originals are in
`public/ui/figma-assist`. Contact/power/elevation cards appear while the configurable
assistance key is held (default Ctrl; touch has a Help toggle); blur/visibility
loss releases it. Live %/m/s gauges are always visible during power selection,
without holding Ctrl. Shift+wheel changes cue elevation. Ranked matches force the
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

## Postgame menu recovery and default cue aiming (2026-11-05)

UI busy ownership now uses an operation token independent of navigation
generation. Successful/failed match exit releases the menu, while an old
operation cannot clear a newer account's busy/error state. Replay-after-leave
also checks the initiating user/session before starting another bot match.

The real match scene opts into the existing first-person cue camera during
heading selection, before the first LMB. The workflow remains heading → contact
→ power; selecting the cue camera alone no longer confirms heading. Explicit
free/top/orbit views survive drawers and modals until the next authoritative
own shot (`match.id` + `snapshot.shotNumber`). Cue placement stays in overview;
the camera returns behind the cue afterwards. Explicit turn ownership exits cue
view on timeout/finish even without a physical-shot trajectory. Spectators and
model/appearance previews retain their free-camera default. Touch uses horizontal
drag for heading, followed by a separate confirmation tap.

Regression coverage includes `tests/postgame-menu.mjs` (real API/finished matches,
all menu actions, replay, search/cancel and an explicitly injected failed leave),
`tests/default-cue-camera.mjs` (real Three renderer, including timeout, modal and
touch transitions), and extended `tests/match-hud.mjs` assertions on the actual
App plus real shared physics. Platform bootstrap remains explicitly simulated.

Verification: production build/typecheck, 74 client checks, dedicated cue-camera
and existing workflow suites, real postgame menu cycles (four completed matches
per browser), extended platform identity/replay regression, and three-client
physical match → finish → responsive main menu all passed in Chromium/WebKit.
Independent code and architecture review found no unresolved blocker.

Deployed `b3bb88e`; default client `/assets/index-CinJDzaL.js`, CSS unchanged.
Static update installed HTML last and retained old chunks; backend PID 328303
was not restarted. Backup: `/opt/pooltool-online/shared/backup-cue-menu-b3bb88e`.
All 52 previously completed match payloads were preserved, database integrity
checked and model catalogue unchanged. Public Chromium/WebKit three-client
tests passed with the actual shared AI table in all clients, real charged
physics, equal final ball states and finish → menu → play without a reload.
Chromium's initial load timed out once; its direct-network rerun passed.
No JS/static-resource failures in the successful runs. Published client hash
matches the tested local build. Guest mode remains on; VK Play remains disabled.

## Full interface audit and input/copy fixes (2026-11-05)

Latest batch: see `online/docs/FIGMA_AUDIT_20261105.md`. High-fidelity contexts for
all six game states and 15 club/settings frames were checked. The power gauges
were mistakenly hidden with Alt help; they now remain visible without help,
using the actual latest 149.714×82.5888 SVG from floating Figma groups. Sidecards
still require the help key, changed to Ctrl at the user's request, configurable
in settings and persisted per profile. Modifier sides are equivalent; native
Ctrl/Meta copy chords remain available, conflicting assist keys cannot shoot.

Cue heading gets the compact direction layout with original ring/arrow; general
view gets its stage instruction/legend, assisted contact gets the original
leader and live contact description. Responsive widget layout is checked for
overlap, central-ball clearance and clipping down to 320px and short desktops.
Settings index shows real right-hand quality/volume/input summaries.

First-person aiming uses Pointer Lock when granted (hidden cursor, unbounded
movement deltas), releasing at first LMB/contact, UI interaction, turn loss and
all lifecycle exits. Denied/unsupported browsers use continuous edge turning,
not unreachable aim sectors. Native Chromium and fallback WebKit are tested
separately; headless WebKit native permission is not claimed.

History uses five stable columns, including an empty Elo cell. General UI text
is nonselectable; room invitation codes and editable input remain selectable.
Clipboard copy falls back to a user-gesture legacy copy path on HTTP, restores
focus/selection, reports success or selects the code for manual copying, and
rejects late identity/navigation-owned feedback. No backend runtime change or
platform publication is required for this batch.

Verification: production build/typecheck, 87 client pure/SSR checks, 164 Python
tests +520 subtests, 84 real-component layout/state combinations across
Chromium/WebKit, pixel fills and native SVG geometry, actual insecure-HTTP copy
events plus App feedback, real persisted assistance-key remapping and native
copy chords, pointer-lock/fallback and projected cue-ball alignment all passed.
The compiled three-client match/HUD test and four-finished-match menu/replay
test per browser passed with zero JS/static-resource errors. Code review
APPROVE; independent architecture review CLEAR. Only the pre-existing Starlette
test-client deprecation warning remains.

Deployed `e9fe4a2` to the ordinary testing URL: client
`/assets/index-CMVoAi06.js`, CSS `/assets/index-DrLBsvdN.css`. Assets were installed
before the HTML entry; old chunks retained, backend PID 328303 unchanged.
Backup: `/opt/pooltool-online/shared/backup-design-input-e9fe4a2`; all 60 prior
completed match payloads preserved, catalogue unchanged, DB integrity checked.
Public Chromium/WebKit passed the actual three-client physical-shot/HUD and
finish→menu→play cycle with the shared AI table loaded by every client, no JS or
static-resource errors. Both also passed real insecure-HTTP invitation copying:
native copy event, exact code, success feedback and no leaked temporary fields.
Published JS/CSS/SVG hashes match the tested local originals. Guest entry remains
enabled and VK Play remains disabled/unconfigured; no credentials changed.

## Safe cursor resume after external focus loss (2026-11-06)

External blur/hidden/unexpected native unlock now creates a persistent local
input-suspension boundary, revoking automatic recapture. Merely returning focus,
network snapshots, new turns and scene recreation cannot clear it. The prepared
heading/contact/power parameters stay unchanged; in-progress pulls are cancelled
without firing. The first foreground scene click is consumed solely to resume
input, before raycast, mouse bindings, placement or phase confirmation. A visible
«Продолжить игру» button provides the same explicit action. The next click is
the normal gameplay action. The network shot clock continues.

HUD contact hover, ranges, phase/shot controls and synchronous handlers are gated
too, without disabling underlying scene eligibility (avoids a resume deadlock).
Native ownership is checked synchronously because pointerLockElement can change
before its queued event. Capture requests have generation/owner guards; a late
old completion cannot cancel a newer valid lease or capture an inactive scene.
Only the scene's own canvas is ever released. Touch activation on pointerup and
cancelled resume gestures are handled separately; denied/unsupported Pointer Lock
keeps the edge-turn fallback after explicit resume.

Read `online/docs/CURSOR_INPUT_LIFECYCLE.md`. New renderer and actual-App/API
regressions distinguish real Chromium native capture from explicitly simulated
focus/API events; headless tab bringToFront is not claimed to certify OS Alt+Tab.

Validation: build/typecheck and all 87 pure/SSR checks passed. Real renderer
cursor-resume and actual-App/API regressions passed Chromium/WebKit, including
late native ownership changes without accidental shot commands. Strict default
cue-camera tests catch false pauses during ordinary UI/camera/turn changes;
three consecutive Chromium runs and WebKit passed. Legacy shot workflow and
four completed-match/menu cycles per browser passed. Independent code review
APPROVE and architecture review CLEAR.

Deployed `1ea5ebc` to the ordinary testing URL with client
`/assets/index-aGRR4d-a.js` and CSS `/assets/index-yJpNpetd.css`. Backup:
`/opt/pooltool-online/shared/backup-cursor-resume-1ea5ebc`. Static assets were
installed before the entry document, old chunks retained, backend PID 328303
unchanged. All 65 pre-existing finished payloads preserved, model catalogue
unchanged, SQLite integrity ok. Published JS/CSS SHA-256 match local tested files.
Public Chromium/WebKit three-client real-physics HUD tests passed, including
explicit resume after blur, a real shot/shared final state and finish→menu→play;
the shared AI table loaded in all three clients, no JS/static-resource errors.
Final legacy postgame regression also passed four completed matches per browser
on this build. Disposable local QA service stopped after verification. No backend,
credentials, VK Play configuration or user library data changed.

## Shot calculation and smooth playback (2026-11-06)

Read `online/docs/SHOT_PERFORMANCE_20261106.md`. The actual reported slow break
was recovered from telemetry (12.699 s, 1,675 events); the checked-in anonymized
fixture includes initial ball order as well as positions/shot parameters.
`OnlineEventDetector` is selected only by the online engine: exact polynomial
reuse and Numba batches plus indexed missing-pair/invalidation caches. Scalar
JIT kernels remain unchanged, desktop/3D use the original paths, and no solver,
epsilon, friction, physics precision, 60 Hz sampling or limits were lowered.
Final same-input/same-process warm remote median: 9.710 s original → 7.557 s
batched (three alternating runs/version, complete results exactly equal).
Extreme dense racks remain CPU-bound; sub-second timing for every shot is not
claimed. The complete diagnostic vectors remain in participant telemetry.

Gameplay packets carry compact event summaries, omit heavy fields before copying
and serialize one broadcast once. Full diagnostics are encoded before the common
playback start is assigned. The lead defaults to 500 ms (existing explicit env
overrides must be updated); staged Chromium/WebKit's six clients received data
175–300 ms before start, versus 111–243 ms late with 120 ms. No client-local
receipt-start or made-up trajectory is used. The client marks recordings raw,
reuses sampler buffers and anchors playback to monotonic rAF time. Audio uses
four cached waveforms, coalesced bursts and a 24-voice cap; future starts are silent.

Validation: 223 Python tests +536 subtests, 92 client pure/SSR checks, 60,000 exact
kernel comparisons, 16 complete variants, the recorded 1,675-event and weak
2,373-event cases, cache mutation/retry/copy/layout/replacement and 3D fallback.
Actual renderer playback/clock/future/catch-up/audio, cursor resume and actual-App
regressions passed Chromium/WebKit. Final compiled three-client real-physics/HUD/
finish→menu→play passed both browsers with equal final states and JS0. Isolated
two-game/four-shot probe passed (development-host p50 173 ms/max 261 ms, not SLA).
Independent code review APPROVE and architecture review CLEAR.

Deployed `63e9a4c` to the ordinary preview URL. Active release:
`/opt/pooltool-online/releases/20261106-physics-latency`; client
`/assets/index-Dm3Ebd1c.js`, CSS `/assets/index-yJpNpetd.css`. Online SQLite backup:
`/opt/pooltool-online/shared/backup-physics-63e9a4c`; all 68 pre-existing finished
payloads preserved byte-identically, catalogue unchanged, integrity ok. Old
release/chunks retained. Physics was warmed at the final path as `ops` before
cutover; backend PID 1024133, two physics processes, one ASGI, about 529 MB cgroup
memory after warmup. Non-secret `shared/shot-performance.env` is loaded through
the dedicated `shot-performance.conf` drop-in (`PHYSICS_WORKERS=2`, playback lead
0.5 s); original credential/platform files were not modified. Guest remains on,
VK Play disabled/unconfigured. Published detector/client hashes match the tested
local files. Local QA, remote isolated QA unit and SSH forward were stopped.

Public final Chromium/WebKit three-client real-physics/shared-AI/HUD/menu checks
passed: server calculations 1.090/0.846 s, all delivery leads positive
(Chromium 261–285 ms, WebKit 198–206 ms), equal final states, JS/static0. The first
Chromium run saw transient HTTP 502 for two ball PNGs; both URLs then returned
200 and the unchanged strict retry passed. No checks were weakened.

## Table pocket geometry repair (2026-11-06)

Read `online/docs/POCKET_REPAIR_20261106.md`. The shared AI table's six rail
chains are now closed, correctly wound lofts, replacing overlapping boxes,
cylinders and fan patches at pocket jaws. A continuous wood deck/closed apron
replaces the warped upper AI shell; the original embedded wood atlas is reused
with clean UVs. Open leather liners have separate hard-crease normals; 0.6 mm
cloth clearance eliminates teal tessellation slivers inside their bores. The
retained lower AI cabinet is decorative. Actual contact lines/arcs, pocket
radii, game physics, table height and ball state are unchanged.

Procedural flat black pocket caps now belong to the replaceable table body,
so custom wells are no longer obscured. Colored markers/labels and picking stay
unchanged. Prepared GLB: 3,080,684 bytes, 81,066 triangles, 64,056 vertices,
seven groups; SHA-256 `12a337bb1a6a6f7b2f24301662379f28557ecad6ee47c00a4dc10be58ab000cc`.
Original source files remain untouched. Generator/artifact guards reject
input/output/sidecar aliases including hardlinks; model-intake README has exact
commands. Older intake statistics in the 20261103 report describe revision 1.

Validation before publication: 15 geometry tests, strict actual-GLB topology/
normals/winding audit (0 defects), 294 open-bore rays, 14,784 clean wood UV samples,
561 legacy cloth rays, 45 Python asset/reference/admin tests, 92 client checks,
build/typecheck. Real renderer Chromium/WebKit: 1711 cloth rays, all 16 balls
visible, six open pockets, cap replacement/reset 6→0→6, stable marker UUIDs,
disposal/reload and JS0. Independent code review APPROVE; architecture CLEAR.
Final closeups and overview checked, including lower cabinet/apron continuity.

Deployed implementation `4d41d17`: ordinary URL serves `index-B2ngEgHf.js`,
`GLTFLoader-QUjeh2Y9.js`; CSS unchanged. Library v5 publishes new immutable ID
`01d31e7634c9409dbbd752197daebd48` with exact V6 hash; old
`2dc5c0956a32488b86e6667aa857d910` disabled, bytes/config retained. Real App with
old explicit personal selection was separately tested: reconciles to default,
loads only the new GLB, no JS/admin writes. Environment selection unchanged.
Online backup `/opt/pooltool-online/shared/backup-pockets-20261106` preserves
SQLite/catalogue/old GLB/entry HTML. All 71 previous finished payloads preserved
byte-identically, integrity ok; backend PID 1024133 unchanged, physics not
restarted, guest on and VK Play disabled/unconfigured. Published client hashes
match the tested build; old hashed chunks retained, entry document switched last.

Public final Chromium/WebKit three-client real-physics/HUD/shared-AI/menu checks
passed: new model in all three clients, 16 ball textures, equal final state,
JS/static0. First Chromium attempt had transient 502 on ball5 PNG and elevation
SVG; both URLs returned 200, unchanged strict retry passed. Fail evidence retained,
no tests weakened. All disposable browser/test processes stopped and own rooms
cleaned up normally. Cosmetic rollback must use catalogue API + old HTML, not
restore the whole live database over matches created after backup.

## Git identity

Author and committer: `el1syum <kilmol606@gmail.com>`. No assistant/co-author
attribution. Use the existing authenticated remote for push.
