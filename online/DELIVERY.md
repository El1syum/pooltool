# Functional delivery — 2026-10-14

The implementation follows `ТЗ pooltool доработки(1).docx` and its linked
interface description. The user explicitly deferred final Figma styling and VK
publication on 2026-10-14. Neither of those deferred items is claimed complete.
The original desktop client is retained; the web client uses the fork's actual
Python physics and EightBall rule engine on an authoritative server.

## Implemented scope

Revised on 2026-10-14 after an independent review; corrections are listed under
Verification and Performance boundary.


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

- Python: 32 tests and 6 subtests pass (the earlier note claimed 42; there were
  28), including real physics and the upstream degenerate ball-collision
  regression; one test-library deprecation warning.
- Client trajectory/input helpers, delta-trajectory expansion and pocket
  mapping: 8 tests pass. Vue/TypeScript type check and production build pass.
- Browser smoke (`browser-smoke.mjs`) re-run on 2026-10-14 in Chromium only, also
  with `NETWORK_DELAY_MS=250`, and `mobile-layout.mjs` (390×844) in Chromium: all
  pass without JavaScript errors. WebKit was not re-run after these changes.
- Manual check in a 1024×768 browser: the match fits the window with controls
  beside the table; an opponent's disconnect shows a forfeit countdown; the
  result screen shows a Russian reason and the rating change; history lists the
  opponent and the Elo delta.
- The `el1s` live/restart probes described in the previous revision predate these
  changes and must be repeated after the next deployment.
- A native Safari run on Apple hardware remains a release check;
  WebKit automation is not a claim of hardware certification.

## Performance boundary

Before this revision every shot started a new Python process and re-imported and
re-warmed pooltool: about 2.5–3.4 s from click to animation locally and 8.7 s on
`el1s`. Workers are now long-lived and pre-warmed; a stalled or crashed worker is
killed and replaced in the background.

Local measurements (Windows desktop, 2 workers, `load_probe.py`, shot request to
confirmed result, all matches shooting almost simultaneously):

| Concurrent matches | p50 | p95 | Response raw / on the wire |
| --- | --- | --- | --- |
| 1–2 | 0.16–0.28 s | 0.22–0.36 s | ~120–180 KB / ~30–46 KB |
| 8 | 0.37 s | 0.92 s | ~175 KB / ~42 KB |
| 16 | 0.56 s | 1.89 s | ~118 KB / ~28 KB |

In the browser, click to animation start was 284 ms (previously 3.4 s). Shot
trajectories are delta-encoded (only moving balls per frame) and compressed on
the wire; previously a single break response was ~874 KB uncompressed and the full
trajectory was re-sent with every later match broadcast. Each resident worker
uses ~230 MB. These are local figures, not a production SLA; `el1s` has two
shared vCPUs and is configured with one worker, so repeat `load_probe.py` there.

The service uses one ASGI process and SQLite. Room lookups use an index on room
status and finished rooms are closed after `ROOM_TTL_SECONDS`, so per-request work
no longer grows with every room ever created; history uses a `match_players`
table. Scaling beyond one host still requires replacing SQLite and the in-process
broadcast hub. Targets and the supported device list should be finalized with
the tech lead after load testing on the production host, as the specification
requires.

## Solo mode and shot latency (2026-10-14, second revision)

A server bot (easy/medium/hard) is available from the play screen. It uses
pooltool's potting geometry, tests candidate shots with the real simulation on
the stronger levels and submits normal commands, so rules, telemetry and replay
are identical to a human opponent. Local full games against the easy and hard
bots finished by the rules with no rejected command or timeout; a bot decision
takes ~0.04–0.1 s (up to ~1.4 s when it must place the cue ball and no pot is
open).

Perceived shot latency was reduced further: the cue stroke animates immediately
on click, the shared playback buffer dropped from 350 ms to 120 ms, and pooltool's
collision-cache invalidation was rewritten without per-key generators (a break
simulation 0.70 s -> 0.53 s; final ball positions are unchanged). Measured
locally in the browser, the balls start moving 356 ms after a click on a break;
an ordinary shot computes in ~50–70 ms.

Commands now go over the already-open WebSocket (HTTP remains the fallback with
the same command ID). From the reviewer's network a new HTTP request to `el1s`
took 0.4–1 s while a socket round trip took 0.08–0.18 s; the server itself
answers in ~2 ms, so most remote latency was the extra request.

## Renderer scope

Physics and rules are the real pooltool engine on the server. The browser view is
a separate, simplified Three.js scene (procedural table and cue, original ball
textures), not the desktop Panda3D renderer, which cannot run in a browser. The
fork's sparse checkout omits pooltool's room/table/cue art. Final visuals follow
the designer's layouts.

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
