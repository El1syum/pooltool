# Functional delivery — 2026-10-14

The implementation follows `ТЗ pooltool доработки(1).docx` and its linked
interface description. The user explicitly deferred final Figma styling and VK
publication on 2026-10-14. Neither of those deferred items is claimed complete.
The original desktop client is retained; the web client uses the fork's actual
Python physics and EightBall rule engine on an authoritative server.

## Implemented scope

| Requirement | Implementation |
| --- | --- |
| Two players, rooms, invitation, matchmaking, observers | Private room codes, ready lobby, casual/ranked queues, observer entry by code, leaving rooms |
| Consistent state, rules and results | Server-owned physical state and rules; shared timestamped trajectories, turns, called ball/pocket, legal ball-in-hand placement |
| Reconnect and failure handling | Durable confirmed state and pending commands, revision checks, exact command deduplication, reconnect grace, turn/match timeouts, surrender, killable simulations and restart recovery |
| Functional screens | Loading/error, menu, play/search, lobby, match/local pause menu, settings, profile/history and result; responsive controls do not overlay the table |
| Input settings | Keyboard and mouse rebinding, conflict warnings, aim sensitivity, reset, graphics/audio, local per-user cache and server persistence for guest or authenticated identity |
| Profile and rating | Editable display name, current Elo, match history; classic Elo with K=32 and initial rating 1000, applied once to ranked results |
| Pocket identification | Six numbered and colored pockets, selectable called pocket |
| Telemetry and diagnostics | Match/shot/result/disconnect/reconnect events, player/session/match/turn IDs, UTC and client version; potted ball and pocket; separate real worker wall-time and simulated motion duration; bounded offline queue and dedupe |

Pause is local: the online turn timer is never paused by opening a menu. Client
positions, winner claims and stale or unauthorized commands are not accepted.
Tokens are hashed in storage and sent in the first WebSocket authentication frame,
not in URLs. Participant telemetry export is authenticated.

## Verification

The reproducible commands and browser harness are documented in
`README.md` and `client/tests/README.md`.

- Python: 42 tests and 6 subtests pass, including real physics and the upstream
  degenerate ball-collision regression; one test-library deprecation warning.
- Client trajectory/input helpers and pocket mapping: 7 tests pass.
- Vue/TypeScript production build passes; npm reports no production dependency
  vulnerabilities at verification time.
- Browser scenarios use separate Chromium/WebKit contexts for two players and
  a 390×844 observer: real shot, consistent final state, reload during playback,
  placement, settings persistence, profile/history, exiting and a new queued match.
- Live API probe on `el1s` passed ranked pairing/Elo, profile/settings/history,
  telemetry dedupe/export and WebSocket reconnect during a real calculation.
- Real service restart on `el1s` restored the exact confirmed snapshot, revision,
  turn and last shot for both players; profile, settings, telemetry and command
  dedupe survived. Readiness returned in 5.83 s. Durable pending-shot recovery is
  also covered by the automated test.
- A full Chromium scenario with 250 ms added to each API request passed without
  JavaScript errors or inconsistent state.
- A native Safari run on Apple hardware remains a release check;
  WebKit automation is not a claim of hardware certification.

## Performance boundary

The local 12-shot warm physics-only benchmark measured p50 0.287 s, p95 1.477 s
and maximum 1.921 s. One remote live-probe shot measured 8.743 s worker wall-time
on the current shared two-vCPU host. These are different measurements, not a
production latency SLA or concurrency/load-test result. Worker wall-time includes
capacity wait, process startup/import/warmup, physics, IPC and cleanup; it excludes
HTTP transport and database/broadcast completion. Motion duration is recorded
separately. Computation cannot consume the next player's turn time.

The service uses one ASGI process and one bounded CPU worker on this host. A
30-second computation limit kills stalled work and restores the remaining turn.
Targets and the supported device list should be finalized with the tech lead
after representative load testing, as the specification requires.

## Deployment and remaining release work

Functional preview: `http://82.25.61.116:8790`. This direct HTTP endpoint is for
testing, not for production credentials or VK launch. The isolated service is
`pooltool-online.service`, with release-local Python environments and persistent
data under `/opt/pooltool-online/shared`. See `ops/README.md` for deployment,
logs, recovery and rollback.

When the designer finishes, implement and verify the approved Figma layouts and
export their real assets. Then configure the chosen VK application, HTTPS/WSS,
platform integration and publication. Final Figma fidelity, VK publication,
native Safari/device certification and production load acceptance are not part
of this functional preview's completed claims.
