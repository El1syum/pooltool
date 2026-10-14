# Pooltool Online

Functional browser multiplayer built around this fork's real pooltool physics.
The existing desktop game remains available through `run-pooltool`. The online
client connects to the authoritative Python service; players need only a browser.

## Current scope

The accepted specification is implemented for functional eight-ball: private
rooms and invite codes, casual/ranked matchmaking, two players and spectators,
server-owned turns/physics/rules, reconnect, timeouts, surrender, Elo, editable
profiles, match history, persistent input/graphics/audio settings and telemetry.
The user deferred final Figma styling and VK publication on 2026-10-14. The client
uses functional controls until finished designer layouts are available.
Physics and rules are the real pooltool engine, but the browser renderer is a
separate, simplified Three.js scene (procedural table, original ball textures):
the desktop Panda3D renderer cannot run in a browser, and the fork's sparse
checkout omits pooltool's room/table/cue art. It does
not use Figma screenshots as assets. Ball textures are original pooltool assets.

## Run locally

Python 3.12 and Node.js 24 are used by the tested build. From the repository root:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --extra-index-url https://archive.panda3d.org/simple/ -r online/runtime-requirements.txt
.\.venv\Scripts\python.exe -m pip install --no-deps -e .
cd online/client
npm ci
npm run build
cd ../..
.\.venv\Scripts\python.exe -m uvicorn online.server.app:app --host 127.0.0.1 --port 8790
```

Open http://127.0.0.1:8790 in two separate browser profiles/private windows. Create
a room, join with its six-character code, and confirm readiness in both clients.
Both ready players start the match automatically. A third browser can join as a
spectator with the same code. After the break, select the called ball and pocket
before striking, as required by pooltool's eight-ball rules. Ball-in-hand after a
foul requires legal cue placement; the opening placement is optional behind the
head string. Settings are stored per guest/user locally and synchronized to the
server; command and telemetry retries are idempotent.

For client hot reload, run `npm run dev` in `online/client`; Vite proxies API and
WebSocket traffic to the same service on port 8790.

## Architecture

The client sends `V0/phi/theta/a/b` and a command ID plus expected revision. Only
the server holds complete physical state and adjudicates the shot. A pool of pre-warmed,
killable CPU processes simulates the real engine, produces trajectories/events,
and commits final state before broadcasting it. Clients interpolate the shared
trajectory using a server timestamp with clock calibration. No client-computed
winner, ball position or coefficient is trusted.

SQLite transactions persist room/match state, commands, profiles, rating and
telemetry. API/WS authority is one service process; do not run multiple Uvicorn
workers against the same SQLite database. The CPU worker count is independent.
Stored session tokens are hashes; WebSocket authentication is in the first frame,
never in query strings. The service has bounded requests, heartbeat, disconnect
grace, match/room expiration and recovery of pending shots after restart.

See [API contract](server/API_CONTRACT.md) for request schemas and [operations](ops/README.md)
for production installation, probes and recovery. The server has no mock fallback.

## Verification

```powershell
.\.venv\Scripts\python.exe -m pytest online/server/tests online/tests -q
cd online/client
npm run build
node --test --experimental-strip-types src/game/playback.test.mjs
```

`python -m online.server.tests.load_probe --matches 8 --shots 3` measures shot latency
under concurrent matches against a running service (see its header for the guest
login limit).

`online/client/tests/browser-smoke.mjs` exercises two real browser clients plus a
spectator against the running service; see its header for the Playwright path and
browser selection. Automated WebKit coverage checks the Safari engine; a native
Safari smoke check on macOS is still required before claiming device certification.

## Configuration

Copy `online/.env.example` to a service environment file. Guest mode requires no
VK credentials. VK signed-parameter authentication is available for the later
integration step but fails explicitly when credentials are absent.

## Licenses

Pooltool and copied textures use Apache-2.0; keep the root LICENSE.txt and
`online/client/public/models/balls/LICENSE.txt`. Dependencies retain their own
licenses. The online additions do not replace upstream attribution.
