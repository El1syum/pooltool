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

The match HUD lives in `online/client/src/components/MatchHud.vue`, with the
Figma SVG exports in `public/ui/figma-match`, self-hosted Inter/Lora fonts and
scoped `match-hud.css`. App.vue remains the network/state authority. Preparation
phases are overview (heading before first LMB) → aim (heading fixed, cue-contact
selection only) → power (heading/contact fixed, downward pull sets V0). Both
dynamic Figma wedge gauges show V0 as percent and m/s, not elevation. The server
still validates and simulates the shot. The accessible parameters drawer
preserves numeric and keyboard controls.

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
http://82.47.143.103:8790 (current SSH alias `el1s`, user `ops`, verified 2026-11-02). Service:
`pooltool-online.service`; releases under `/opt/pooltool-online/releases`, active
symlink `/opt/pooltool-online/current`, persistent data/config under `shared`.
No existing Cyberpool or other server applications are replaced.

This is an HTTP testing preview. Configure HTTPS/WSS before production identity
or platform integration. One ASGI worker owns state; the CPU worker is separate.
Do not run multiple ASGI workers against the current SQLite authority.

Read `online/README.md`, `online/server/API_CONTRACT.md`,
`online/DELIVERY.md` and `online/ops/README.md` for commands and verified scope.
Native Safari/device certification, a production load SLA, final Figma styling
and VK publication are explicitly not claimed complete.

## Git identity

Author and committer: `el1syum <kilmol606@gmail.com>`. No assistant/co-author
attribution. Use the existing authenticated remote for push.
