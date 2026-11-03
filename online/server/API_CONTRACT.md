# Pooltool Online API v1

Run from repository root: `uvicorn online.server.app:app --port 8790`.
All dates are UTC ISO 8601, except explicitly named epoch-millisecond playback
timestamps. Player HTTP authentication is `Authorization: Bearer <token>`.
Session tokens are opaque, stored only as SHA-256 hashes, and expire after 30 days.
No desktop utility is required. The browser renders trajectories; pooltool physics
and eight-ball rule decisions run on the server.

## Shared cosmetic model library

The library is public to read. Its administration has an independent login;
player bearer tokens or nicknames never authorize a library mutation.

| Method/path | Body | Response |
|---|---|---|
| GET `/api/assets/library` | — | `{version,assets,profile:{tableId,environmentId},updatedAt}` |
| GET `/api/assets/table-reference` | — | `{snapshot}`: detached cached initial geometry from the actual game engine; no room/match is created |
| GET `/api/assets/library?includeDisabled=true` | admin cookie | same, includes disabled models |
| GET/HEAD `/models/library/{id}.glb` | — | immutable `model/gltf-binary` file; disabled/missing = 404 |
| POST `/api/assets/admin/login` | `{username,password}` | `{authenticated:true,username,csrfToken,expiresAt}` + HttpOnly cookie |
| GET `/api/assets/admin/session` | — | `{authenticated,configured,username?,csrfToken?,expiresAt?}` |
| POST `/api/assets/admin/logout` | — | `{authenticated:false}` |
| POST `/api/assets/models?name=...&role=table` | raw GLB bytes | `{asset,version}` |
| PATCH `/api/assets/models/{id}` | `{name?,role?,enabled?,config?,expectedVersion?}` | `{asset,version}` |
| DELETE `/api/assets/models/{id}` | — | `{asset,version}` (soft disable) |
| PUT `/api/assets/library/profile` | `{tableId,environmentId,configs?,expectedVersion?}` | library snapshot |

`asset = {id,name,role,bytes,sha256,enabled,config,url,createdAt,updatedAt}`.
Roles are `table` and `environment`; each selected ID must be an enabled model of
that role. IDs are server-generated lowercase hex, never user-provided paths.
Upload content type must be `model/gltf-binary` or `application/octet-stream`;
uploads are raw bodies, not multipart. Files are capped at 50 MiB and must be
self-contained GLB 2 without external URIs or required Draco/Meshopt/KTX2 decoders.

`config` contains `position:[x,y,z]` (metres), `rotation:[x,y,z]` (XYZ degrees),
`scale:[x,y,z]`, `replaceProcedural:boolean`, `material`, `materials` (overrides by
material name), and `hiddenNodes` (node names). The origin is the authoritative
cloth centre and the renderer uses Y-up glTF coordinates. Material overrides
support `color`, `roughness`, `metalness`, `emissive`, `emissiveIntensity`; colours
are `#RRGGBB`. Position is limited to ±100 m, rotation to ±3600°, scale to
0.0001–1000, roughness/metalness to 0–1, emissive intensity to 0–10. Values must
be finite. Unknown fields are rejected. PATCH merges supplied config fields with
the existing config; a supplied material/map field replaces that field.

Profile `configs?:Record<selected-id,config>` publishes both slots and their full
draft configs atomically. An optional `expectedVersion` guards against concurrent
edits and returns 409 if stale. Every successful mutation increments the global
integer version. Disabling or changing the role of a selected model clears that
slot; restoring with `enabled:true` preserves its ID, metadata and file. No endpoint
permanently deletes files. With null slots the renderer keeps its procedural art.

Administrator cookies are `pooltool_asset_admin`, HttpOnly, SameSite Strict,
path `/api/assets`, eight-hour TTL, Secure only on HTTPS. Every authenticated
mutation, including logout, requires `X-Asset-CSRF` from login/session in addition
to the cookie. GET session does not require CSRF and restores the token after a
reload. A supplied Origin must be the actual same origin; an omitted Origin is
allowed only with valid cookie and CSRF for writes. Errors use `{detail:string}` or
`{detail:[{loc,msg,type}]}` without echoing passwords. Unconfigured credentials
return 503; missing/expired auth = 401, CSRF/origin = 403, oversized body = 413,
invalid MIME = 415, invalid model/config = 422, login rate limit = 429.

Administrator HTTP access is allowed only for the user's explicitly accepted
testing preview; it is unencrypted and requires a unique testing-only password.
Library objects are cosmetic and do not modify server-authoritative physics.

## Authentication and profile

| Method/path | Body | Response |
|---|---|---|
| POST `/api/auth/guest` | `{displayName?,clientVersion?}` | `{token,user}` |
| POST `/api/auth/vk` | `{launchParams,clientVersion?}` | `{token,user}` |
| GET `/api/me` | — | `{user}` |
| PATCH `/api/me` | `{displayName}` | `{user}` |
| GET `/api/me/settings` | — | `{settings}` |
| PUT `/api/me/settings` | `{settings:{...}}` or settings object | `{settings}` |
| GET `/api/me/history?limit=50` | — | `{matches:[summary...]}` |
| GET `/api/me/current` | — | `{room,match,queue}`; absent room/match are null |

`user = {id,displayName,elo,games,wins,losses,settings,isVk}`.
Guest identity persists by retaining the token in browser storage. VK identities
are linked only after HMAC signature, application ID, user ID and timestamp checks.
Configure `VK_APP_ID` and `VK_APP_SECRET`; missing credentials return 503.

## Rooms and matchmaking

| Method/path | Body | Response |
|---|---|---|
| POST `/api/rooms` | `{settings?:{turnSeconds:60,ranked:false}}` | `{room}` |
| GET `/api/rooms/{code}` | — | `{room}`; nonmembers receive only preview |
| POST `/api/rooms/{code}/join` | — | `{room,match?}` |
| POST `/api/rooms/{code}/spectate` | — | `{room,match?}` |
| PATCH `/api/rooms/{code}/settings` | `{turnSeconds,ranked:false}` | `{room}` |
| POST `/api/rooms/{code}/ready` | `{ready:true}` | `{room,match?}` |
| POST `/api/rooms/{code}/start` | — | `{room,match}` |
| POST `/api/rooms/{code}/leave` | — | `{room}` |
| POST `/api/matchmaking` | `{mode:"casual"|"ranked"}` | `{queued,mode?,room?,matchId?,ratingWindow?}` |
| GET `/api/matchmaking` | — | same queue state |
| DELETE `/api/matchmaking` | — | `{queued:false}` |

`room = {id,code,hostId,players:[{id,displayName,elo,ready}],spectators:[userId],
status,settings,matchId,createdAt,matchmaking}`. Codes are case-insensitive.
Players and spectators belong to one room at a time. Both ready players start
automatically. Settings changes reset readiness. Only host changes settings.
Private friend rooms are unranked; rated matches originate in the ranked queue.
Ranked search starts within 100 Elo and expands by 100 every 10 seconds to 1000.
One queue entry per player prevents duplicate matching. Closing the last socket
while searching cancels search. Casual search ignores rating.

## Matches and authoritative commands

GET `/api/matches/{matchId}` returns `{match}` only to participants or joined
spectators. POST `/api/matches/{matchId}/commands` accepts:

```json
{"commandId":"unique_uuid","expectedRevision":0,"type":"shot",
 "payload":{"V0":3,"phi":90,"theta":0,"a":0,"b":0,
            "ballCall":"1","pocketCall":"lb"}}
```

Other types: `placeCueBall` with `{x,y}`, and `surrender` with `{}`. Aim is in
degrees; V0 is m/s (0.05–8); theta is 0–60; a/b are cue contact coordinates with
`a²+b² <= .81`. The server rejects extra fields, positions and claimed outcomes.
Eight-ball requires a called ball/pocket after the opening break. Pocket IDs are
`lb,lc,lt,rt,rc,rb`; UI numeric aliases 1–6 are accepted by the engine.
Only the current player may shoot/place. Spectators cannot issue commands.
Placement is accepted only with ball-in-hand and legal position/overlap checks.

Responses: `{match,result?,duplicate:false}`. Repeating the exact command ID and
body returns the stored response with `duplicate:true`; in-flight repeats also
include `pending:true`. Reusing an ID with different body/player is 409. A stale
revision is 409 with `{detail:{message,match}}`, so the client refreshes the state.
Commands are durable before physics starts. Client disconnect cannot cancel a
registered shot. Rule admissibility is checked before mutating state; illegal
commands cannot extend the timer. Physics failure restores the remaining turn
time and returns 422. A surrendered
or disconnected match cannot be overwritten by a later physics response.

`match = {id,roomId,roomCode,revision,status,players,currentPlayer,turn,deadline,
startedAt,finishedAt,winnerId,winner,reason,ranked,snapshot,lastShot,playbackUntil,
serverTime,turnRemainingSeconds,disconnectedPlayers,ratings?}`. Status is active/calculating/finished.
`disconnectedPlayers` maps an offline player ID to the UTC time their forfeit
takes effect; it is broadcast as soon as the socket drops and cleared on reconnect.

The browser derives its ranked aim-guide presentation rule from this server-owned
`match.ranked`, never from personal preferences or the selected search mode. While
a ranked match is active/calculating (including reconnect), the aim line is forced
off and its settings control is disabled for players and spectators. The saved
casual `showAimGuide` preference is not overwritten and is restored after a
confirmed finish or leaving the match. This is a client presentation rule, not a
claim that a modified renderer is a tamper-proof anti-cheat boundary.

`snapshot` holds public balls/table/rule constraints; internal simulation state
is never sent to the client. `result` includes trajectory, events, potted,
initialState, finalState, duration (simulated seconds), wallDuration (real compute
seconds), rules, shotId, commandId, playerId and playbackStartAt (epoch ms).
`lastShot = {shotId,commandId,playerId,startAt,startedAt,result}` preserves playback
for reconnect; after `playbackUntil` the trajectory/initialState/finalState are
omitted from later broadcasts and reads (the snapshot is then authoritative).
`trajectory = {duration,dt,encoding:"delta",frames:[{t,balls}],events}`: the first
frame lists every ball, later frames only changed balls, each as
`[id,x,y,z,state,qx,qy,qz,qw]` (positions 0.01 mm, quaternion 1e-4). Both clients play from the same timestamp (`PLAYBACK_BUFFER_SECONDS`, default 120 ms;
a late receiver skips the frames it missed).
The next shot cannot begin before `playbackUntil`; its timer begins after playback.
History items (`GET /api/me/history`) also carry `opponentName` and the caller's
`eloDelta` (null for casual matches). Error `detail` texts are Russian.
Every authoritative change increments revision. Timeout gives the opponent
ball-in-hand through the real ruleset. Forfeit/disconnect applies one result and
one Elo update atomically. K=32, initial Elo 1000. Casual games do not alter Elo.

## Solo play against the bot

POST `/api/solo` with `{difficulty:"easy"|"medium"|"hard", turnSeconds?}` creates a
started casual match against the server bot (player ID `bot:<difficulty>`, room
`settings.solo:true`). The bot has no special access: on its turn the server
computes a decision in a physics worker (pooltool's pot geometry; medium/hard
also test candidates with the real simulation, then add aiming noise) and submits
ordinary `placeCueBall`/`shot` commands, which are validated, simulated, recorded
in telemetry and broadcast like a player's. It plays `BOT_THINK_SECONDS` (0.6)
after the previous playback ends. Solo matches never change Elo; when the human
leaves, the bot wins and the room closes.

## WebSocket

Connect `/ws` and within 10 seconds send `{type:"auth",token,clientVersion}`.
Tokens never go in URLs. Server sends `authenticated` with user/serverTime;
`restored` with room/match/queue; then broadcasts `room`, `match` (optionally
result), `matchmaking`, or `error`. Client sends `{type:"ping",clientTime}` every
20 seconds; server returns `{type:"pong",serverTime,clientTime}`. Send `{type:"sync"}`
to receive restored state. Up to 5 sockets/player.

Match commands can also be sent on the open socket, which saves a request round
trip: `{type:"command",matchId,command:{commandId,expectedRevision,type,payload}}`.
Validation, authority and idempotency are those of the HTTP route. The reply is
`{type:"commandResult",commandId,ok:true,match,duplicate}` or
`{type:"commandResult",commandId,ok:false,status,detail}`. A shot's `result` is not
repeated in the reply: the preceding `match` broadcast on the same socket carries
it. Clients fall back to the HTTP route with the same `commandId` if the socket
drops. Dead sockets expire after 45s.

Disconnect grace defaults to 30 seconds. Reconnect restores durable state and
clears grace timer. Server restart grants all clients a fresh grace period and
resumes any registered pending shot. If both players fail to reconnect the match
ends abandoned without rating change; one disconnected player forfeits. Maximum
match duration defaults to 90 minutes; open rooms, and finished rooms nobody
left, are closed after `ROOM_TTL_SECONDS` (1 hour).

## Telemetry

POST `/api/telemetry/events` with `{events:[{id,type,clientVersion,timestamp,
matchId?,turnId?,data}]}`. Types: clientError/clientPerformance/clientVisibility/
clientReconnect. Scalar data keys: message/code/fps/latencyMs/width/height/
visibility/durationMs/count/reason/connected/visible/drawCalls/triangles.
Maximum 50 events and 4KiB data/event.
Response `{accepted,duplicates,acceptedIds}` acknowledges retries as well.
IDs deduplicate per player; unauthorized match references reject the batch.
Server events include matchStart/matchEnd/shotStart/shotResult/shotRejected/
turnTimeout/disconnect/reconnect/serverRecovery/cueBallPlacement with player,
session, match, turn, client version and server UTC timestamps. No tokens are
stored in telemetry. Shot events include balls/pockets and separate compute and
simulation durations. Client should retain unacknowledged events for retry.
Participants can export their match events via GET `/api/matches/{matchId}/telemetry`
(maximum 1000 events). Spectators cannot read these diagnostic records.

## Deployment and readiness

`/health`, `/api/health`, `/ready` return 200 only when the real physics engine
initializes; unavailable engine gives 503 (no mock fallback). `/ready` also stays
503 (`status: warming`) until at least one warm physics worker exists. Client dist is
served at `/` when `online/client/dist` exists. OpenAPI is at `/openapi.json`.
Environment: POOLTOOL_DB, PHYSICS_WORKERS, SHOT_COMPUTE_TIMEOUT_SECONDS,
DISCONNECT_GRACE_SECONDS, MAX_MATCH_SECONDS, ROOM_TTL_SECONDS, CORS_ORIGINS,
GUEST_LOGINS_PER_MINUTE (per IP, default 20).
Run one ASGI worker per SQLite service. Physics runs in a pool of long-lived,
pre-warmed CPU processes; an over-time or crashed job's process is killed and
replaced in the background, and each process is recycled after 500 shots. Multiple API workers require shared
room broadcasting/locks infrastructure and are intentionally not enabled.
