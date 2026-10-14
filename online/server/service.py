"""Authoritative 1v1 match orchestration, independent of HTTP transport."""

from __future__ import annotations

import asyncio
import copy
import math
import os
import secrets
import time
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException

from .auth import new_token, token_hash
from .storage import Store, decode, encode
from .worker import PhysicsWorkers


def utc(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def epoch(value: str | None) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() if value else 0


def uid() -> str:
    return str(uuid.uuid4())


class GameService:
    def __init__(self, store: Store, engine, *, process_pool=True, now=time.time):
        self.store = store
        self.engine = engine
        self.now = now
        self.lock = asyncio.Lock()
        self.pool = PhysicsWorkers() if process_pool else None
        self.emit = self._noop
        self.connected: dict[str, int] = {}
        self.tasks: set[asyncio.Task] = set()
        self.grace = int(os.getenv("DISCONNECT_GRACE_SECONDS", "30"))
        self.compute_timeout = int(os.getenv("SHOT_COMPUTE_TIMEOUT_SECONDS", "30"))
        self.max_match_seconds = int(os.getenv("MAX_MATCH_SECONDS", "5400"))
        self.room_ttl = int(os.getenv("ROOM_TTL_SECONDS", "3600"))
        self.closed = False

    async def _noop(self, recipients, message):
        return None

    def _spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        def finished(completed):
            self.tasks.discard(completed)
            if not completed.cancelled():
                completed.exception()  # Durable failures are already recorded in telemetry.
        task.add_done_callback(finished)
        return task

    def _user(self, user_id):
        row = self.store.db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Игрок не найден")
        return {"id": row["id"], "displayName": row["display_name"], "elo": row["elo"],
                "games": row["games"], "wins": row["wins"], "losses": row["losses"],
                "settings": decode(row["settings"]), "isVk": row["vk_id"] is not None}

    def _rooms(self, *statuses):
        # Uses the rooms_status expression index; closed rooms are never scanned.
        marks = ",".join("?" * len(statuses))
        return [decode(row["payload"]) for row in self.store.db.execute(
            f"SELECT payload FROM rooms WHERE json_extract(payload,'$.status') IN ({marks})", statuses)]

    def _room(self, code):
        row = self.store.db.execute("SELECT payload FROM rooms WHERE code=?", (code.upper(),)).fetchone()
        if not row:
            raise HTTPException(404, "Комната не найдена")
        return decode(row["payload"])

    def _room_id(self, room_id):
        row = self.store.db.execute("SELECT payload FROM rooms WHERE id=?", (room_id,)).fetchone()
        return decode(row["payload"]) if row else None

    def _match(self, match_id):
        row = self.store.db.execute("SELECT * FROM matches WHERE id=?", (match_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Матч не найден")
        return decode(row["payload"]), decode(row["physics"]), decode(row["pending"]) if row["pending"] else None

    def _active_rows(self):
        # Finished playback payloads may be large; do not parse every old match each second.
        return list(self.store.db.execute("SELECT * FROM matches WHERE json_extract(payload,'$.status') IN ('active','calculating')"))

    def _save_room(self, db, room):
        db.execute("INSERT INTO rooms(id,code,payload,updated_at) VALUES(?,?,?,?) "
                   "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
                   (room["id"], room["code"], encode(room), self.now()))

    def _save_match(self, db, match, physics, pending=None):
        db.execute("INSERT INTO matches(id,room_id,payload,physics,pending,updated_at) VALUES(?,?,?,?,?,?) "
                   "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,physics=excluded.physics,"
                   "pending=excluded.pending,updated_at=excluded.updated_at",
                   (match["id"], match["roomId"], encode(match), encode(physics),
                    encode(pending) if pending else None, self.now()))

    def _event(self, db, kind, *, player=None, session=None, match=None, payload=None, event_id=None, client_version=None, turn_id=None):
        db.execute("INSERT OR IGNORE INTO telemetry VALUES(?,?,?,?,?,?,?,?,?)",
                   (event_id or uid(), kind, player, session, match["id"] if match else None,
                    turn_id if turn_id is not None else (match.get("turn", 0) if match else None), client_version or "server",
                    utc(self.now()), encode(payload or {})))

    def public_match(self, match):
        result = copy.deepcopy(match)
        # Players see who is offline and when the forfeit takes effect.
        result["disconnectedPlayers"] = {player_id: utc(since + self.grace)
                                         for player_id, since in result.pop("disconnected", {}).items()}
        last = result.get("lastShot")
        if last and last.get("result") and epoch(match.get("playbackUntil")) <= self.now():
            # Playback is over; clients only need the confirmed snapshot, not ~50-200 KB of frames.
            for key in ("trajectory", "trajectories", "initialState", "finalState"):
                last["result"].pop(key, None)
        result["serverTime"] = utc(self.now())
        result["turnRemainingSeconds"] = max(0, math.ceil(epoch(match.get("deadline")) - self.now()))
        return result

    def _recipients(self, room):
        return [p["id"] for p in room["players"]] + list(room["spectators"])

    async def announce_room(self, room):
        await self.emit(self._recipients(room), {"type": "room", "room": room})

    async def announce_match(self, match, result=None):
        room = self._room_id(match["roomId"])
        if room:
            event = {"type": "match", "match": self.public_match(match)}
            if result is not None:
                if event["match"].get("lastShot"):
                    event["match"]["lastShot"].pop("result", None)
                event["result"] = result
            await self.emit(self._recipients(room), event)

    def session(self, raw_token):
        if not isinstance(raw_token, str) or not raw_token or len(raw_token) > 256:
            raise HTTPException(401, "Требуется авторизация")
        row = self.store.db.execute("SELECT * FROM sessions WHERE token_hash=? AND expires_at>?",
                                    (token_hash(raw_token), self.now())).fetchone()
        if not row:
            raise HTTPException(401, "Сессия истекла или недействительна")
        return {"id": row["token_hash"][:16], "userId": row["user_id"], "clientVersion": row["client_version"]}

    async def authenticate(self, display_name="Гость", client_version="unknown", vk_id=None):
        async with self.lock:
            with self.store.transaction() as db:
                row = db.execute("SELECT id FROM users WHERE vk_id=?", (vk_id,)).fetchone() if vk_id else None
                user_id = row["id"] if row else uid()
                if not row:
                    db.execute("INSERT INTO users(id,vk_id,display_name,created_at) VALUES(?,?,?,?)",
                               (user_id, vk_id, display_name, self.now()))
                token = new_token()
                db.execute("INSERT INTO sessions VALUES(?,?,?,?,?)", (token_hash(token), user_id,
                           self.now(), self.now() + 30 * 86400, client_version))
        return {"token": token, "user": self._user(user_id)}

    async def update_profile(self, user_id, display_name=None, settings=None):
        async with self.lock:
            with self.store.transaction() as db:
                if display_name is not None:
                    db.execute("UPDATE users SET display_name=? WHERE id=?", (display_name, user_id))
                if settings is not None:
                    db.execute("UPDATE users SET settings=? WHERE id=?", (encode(settings), user_id))
                for room in filter(None, [self._membership(user_id)]):
                    changed = False
                    for player in room["players"]:
                        if player["id"] == user_id and display_name is not None:
                            player["displayName"] = display_name
                            changed = True
                    if changed:
                        self._save_room(db, room)
        return self._user(user_id)

    def _membership(self, user_id):
        for room in self._rooms("open", "playing", "finished"):
            if any(p["id"] == user_id for p in room["players"]) or user_id in room["spectators"]:
                return room
        return None

    def _ensure_free(self, user_id):
        room = self._membership(user_id)
        if room:
            raise HTTPException(409, {"message": "Сначала выйдите из текущей комнаты", "roomCode": room["code"]})

    def _new_room(self, host_id, settings, *, players=None, matchmaking=False):
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        while True:
            code = "".join(secrets.choice(alphabet) for _ in range(6))
            if not self.store.db.execute("SELECT 1 FROM rooms WHERE code=?", (code,)).fetchone():
                break
        host = self._user(host_id)
        return {"id": uid(), "code": code, "hostId": host_id,
                "players": players or [{"id": host_id, "displayName": host["displayName"], "elo": host["elo"], "ready": False}],
                "spectators": [], "status": "open", "settings": settings, "matchId": None,
                "createdAt": utc(self.now()), "matchmaking": matchmaking}

    async def create_room(self, user_id, settings):
        async with self.lock:
            self._ensure_free(user_id)
            with self.store.transaction() as db:
                db.execute("DELETE FROM matchmaking WHERE user_id=?", (user_id,))
                room = self._new_room(user_id, settings)
                self._save_room(db, room)
        await self.announce_room(room)
        return {"room": room}

    async def join_room(self, code, user_id, spectate=False):
        async with self.lock:
            room = self._room(code)
            member = any(p["id"] == user_id for p in room["players"])
            if member or user_id in room["spectators"]:
                result = {"room": room}
                if room["matchId"]:
                    result["match"] = self.public_match(self._match(room["matchId"])[0])
                return result
            self._ensure_free(user_id)
            if room["status"] == "closed":
                raise HTTPException(410, "Комната закрыта")
            if not spectate and (len(room["players"]) >= 2 or room["status"] != "open"):
                raise HTTPException(409, "В комнате нет свободного места игрока")
            if spectate and len(room["spectators"]) >= 100:
                raise HTTPException(409, "Достигнут лимит наблюдателей")
            user = self._user(user_id)
            with self.store.transaction() as db:
                db.execute("DELETE FROM matchmaking WHERE user_id=?", (user_id,))
                if spectate:
                    room["spectators"].append(user_id)
                else:
                    room["players"].append({"id": user_id, "displayName": user["displayName"], "elo": user["elo"], "ready": False})
                self._save_room(db, room)
        await self.announce_room(room)
        result = {"room": room}
        if room["matchId"]:
            result["match"] = self.public_match(self._match(room["matchId"])[0])
        return result

    def authorize_match(self, match_id, user_id, *, participant=False):
        match, physics, pending = self._match(match_id)
        room = self._room_id(match["roomId"])
        players = [p["id"] for p in match["players"]]
        allowed = players if participant else players + (room["spectators"] if room else [])
        if user_id not in allowed:
            raise HTTPException(403, "Этот матч недоступен вашему аккаунту")
        return match, physics, pending

    async def configure_room(self, code, user_id, settings):
        async with self.lock:
            room = self._room(code)
            if room["hostId"] != user_id:
                raise HTTPException(403, "Менять настройки комнаты может только её создатель")
            if room["status"] != "open":
                raise HTTPException(409, "Матч уже начался")
            if settings.get("ranked") is True:
                raise HTTPException(422, "Рейтинговые матчи создаются только через рейтинговый поиск")
            room["settings"].update(settings)
            for player in room["players"]:
                player["ready"] = False
            with self.store.transaction() as db:
                self._save_room(db, room)
        await self.announce_room(room)
        return {"room": room}

    def _start(self, db, room):
        state = self.engine.new_match()
        snapshot = state["snapshot"]
        current_player = snapshot.get("currentPlayer", 0)
        match = {"id": uid(), "roomId": room["id"], "roomCode": room["code"], "revision": 0,
                 "status": "active", "players": copy.deepcopy(room["players"]), "currentPlayer": current_player,
                 "turn": 1, "deadline": utc(self.now() + room["settings"]["turnSeconds"]),
                 "startedAt": utc(self.now()), "finishedAt": None, "winnerId": None, "winner": None,
                 "reason": None, "ranked": room["settings"].get("ranked", False), "snapshot": snapshot,
                 "lastShot": None, "playbackUntil": None, "disconnected": {}}
        room["status"] = "playing"
        room["matchId"] = match["id"]
        self._save_room(db, room)
        self._save_match(db, match, state)
        db.executemany("INSERT OR IGNORE INTO match_players(match_id,user_id) VALUES(?,?)",
                       [(match["id"], player["id"]) for player in match["players"]])
        self._event(db, "matchStart", match=match, payload={"playerIds": [p["id"] for p in match["players"]], "ranked": match["ranked"]})
        return match

    async def ready_room(self, code, user_id, ready=True, start=False):
        async with self.lock:
            room = self._room(code)
            if room["status"] != "open":
                raise HTTPException(409, "Комната не ожидает игроков")
            player = next((p for p in room["players"] if p["id"] == user_id), None)
            if not player:
                raise HTTPException(403, "Подтвердить готовность могут только игроки комнаты")
            if start and room["hostId"] != user_id:
                raise HTTPException(403, "Начать матч может только создатель комнаты")
            if not start:
                player["ready"] = ready
            if start and (len(room["players"]) != 2 or not all(p["ready"] for p in room["players"])):
                raise HTTPException(409, "Оба игрока должны подтвердить готовность")
            match = None
            with self.store.transaction() as db:
                if len(room["players"]) == 2 and all(p["ready"] for p in room["players"]):
                    match = self._start(db, room)
                else:
                    self._save_room(db, room)
        await self.announce_room(room)
        if match:
            await self.announce_match(match)
        return {"room": room, **({"match": self.public_match(match)} if match else {})}

    def _finish(self, db, match, physics, winner, reason):
        if match["status"] == "finished":
            return
        match["status"] = "finished"
        match["finishedAt"] = utc(self.now())
        match["deadline"] = None
        match["winner"] = winner
        match["winnerId"] = match["players"][winner]["id"] if winner is not None else None
        match["reason"] = reason
        room = self._room_id(match["roomId"])
        if room:
            room["status"] = "finished"
            self._save_room(db, room)
        if winner is not None:
            p0, p1 = [self._user(p["id"]) for p in match["players"]]
            rating_delta = round(32 * ((1 if winner == 0 else 0) - 1 / (1 + 10 ** ((p1["elo"] - p0["elo"]) / 400)))) if match["ranked"] else 0
            changes = []
            for index, player in enumerate((p0, p1)):
                new_elo = max(0, player["elo"] + (rating_delta if index == 0 else -rating_delta))
                db.execute("UPDATE users SET games=games+1,wins=wins+?,losses=losses+?,elo=? WHERE id=?",
                           (int(index == winner), int(index != winner), new_elo, player["id"]))
                changes.append({"playerId": player["id"], "before": player["elo"], "after": new_elo, "delta": new_elo - player["elo"]})
            match["ratings"] = changes
        self._save_match(db, match, physics)
        db.execute("UPDATE commands SET status='done',response=? WHERE match_id=? AND status='pending'",
                   (encode({"match": self.public_match(match), "cancelled": True, "duplicate": False}), match["id"]))
        self._event(db, "matchEnd", match=match, payload={"winnerId": match["winnerId"], "reason": reason, "ratings": match.get("ratings", [])})

    async def leave_room(self, code, user_id):
        async with self.lock:
            room = self._room(code)
            if user_id not in self._recipients(room):
                raise HTTPException(403, "Вы не состоите в этой комнате")
            previous_recipients = self._recipients(room)
            match = None
            with self.store.transaction() as db:
                if user_id in room["spectators"]:
                    room["spectators"].remove(user_id)
                else:
                    if room["matchId"]:
                        match, physics, _ = self._match(room["matchId"])
                        if match["status"] != "finished":
                            index = next(i for i, p in enumerate(match["players"]) if p["id"] == user_id)
                            match["revision"] += 1
                            self._finish(db, match, physics, 1 - index, "left")
                    room = self._room(code)
                    room["players"] = [p for p in room["players"] if p["id"] != user_id]
                    if room["players"]:
                        room["hostId"] = room["players"][0]["id"]
                    else:
                        room["status"] = "closed"
                    for player in room["players"]:
                        player["ready"] = False
                self._save_room(db, room)
        await self.emit(previous_recipients, {"type": "room", "room": room})
        if match:
            await self.emit(previous_recipients, {"type": "match", "match": self.public_match(match)})
        return {"room": room}

    async def command(self, match_id, user_id, command, session):
        request = encode(command)
        async with self.lock:
            match, physics, _ = self.authorize_match(match_id, user_id, participant=True)
            existing = self.store.db.execute("SELECT * FROM commands WHERE match_id=? AND command_id=?",
                                             (match_id, command["commandId"])).fetchone()
            if existing:
                if existing["actor_id"] != user_id or decode(existing["request"]) != command:
                    raise HTTPException(409, "Идентификатор команды уже использован с другими параметрами")
                if existing["status"] == "rejected":
                    raise HTTPException(422, decode(existing["response"])["detail"])
                return {**(decode(existing["response"]) if existing["response"] else {"match": self.public_match(match), "pending": True}), "duplicate": True}
            if command["expectedRevision"] != match["revision"]:
                raise HTTPException(409, {"message": "Состояние матча изменилось; обновлено", "match": self.public_match(match)})
            if match["status"] == "finished":
                raise HTTPException(409, "Матч завершён")
            index = next(i for i, p in enumerate(match["players"]) if p["id"] == user_id)
            action = command["type"]
            if action != "surrender":
                if match["status"] != "active":
                    raise HTTPException(409, "Предыдущий удар ещё рассчитывается")
                if index != match["currentPlayer"]:
                    raise HTTPException(403, "Сейчас не ваш ход")
                if epoch(match.get("deadline")) <= self.now():
                    raise HTTPException(409, "Время хода истекло")
                if epoch(match.get("playbackUntil")) > self.now():
                    raise HTTPException(409, "Дождитесь окончания предыдущего удара")
                if action == "shot":
                    try:
                        self.engine.validate_shot(physics, command["payload"], shooter=index)
                    except ValueError as error:
                        raise HTTPException(422, str(error)) from None
            match["revision"] += 1
            pending = None
            response = None
            with self.store.transaction() as db:
                db.execute("INSERT INTO commands VALUES(?,?,?,?,?,?,?)", (match_id, command["commandId"], user_id,
                           request, "pending", None, self.now()))
                if action == "surrender":
                    self._finish(db, match, physics, 1 - index, "surrender")
                    response = {"match": self.public_match(match), "duplicate": False}
                elif action == "placeCueBall":
                    try:
                        physics = self.engine.place_cue_ball(physics, command["payload"]["x"], command["payload"]["y"], shooter=index)
                    except (KeyError, ValueError) as error:
                        raise HTTPException(422, str(error)) from None
                    match["snapshot"] = physics["snapshot"]
                    self._save_match(db, match, physics)
                    response = {"match": self.public_match(match), "duplicate": False}
                    self._event(db, "cueBallPlacement", player=user_id, session=session["id"], match=match,
                                client_version=session["clientVersion"], payload=command["payload"])
                else:
                    pending = {"command": command, "userId": user_id, "shooter": index,
                               "startedAt": self.now(), "session": session, "turn": match["turn"],
                               "remainingSeconds": max(0, epoch(match["deadline"]) - self.now())}
                    match["status"] = "calculating"
                    match["deadline"] = None
                    self._save_match(db, match, physics, pending)
                    self._event(db, "shotStart", player=user_id, session=session["id"], match=match,
                                client_version=session["clientVersion"], payload={"commandId": command["commandId"], "shot": command["payload"]})
                if response:
                    db.execute("UPDATE commands SET status='done',response=? WHERE match_id=? AND command_id=?",
                               (encode(response), match_id, command["commandId"]))
        await self.announce_match(match)
        if pending:
            # Shield a durable command from a browser closing its HTTP connection.
            task = self._spawn(self._calculate(match_id, physics, pending))
            return await asyncio.shield(task)
        return response

    async def _calculate(self, match_id, physics, pending):
        started = time.perf_counter()
        result = None
        error = None
        try:
            if self.pool:
                job = self.pool.calculate(physics, pending["command"]["payload"], pending["shooter"], self.compute_timeout)
            else:
                job = asyncio.to_thread(self.engine.simulate, physics, pending["command"]["payload"], shooter=pending["shooter"])
            result = await asyncio.wait_for(job, timeout=self.compute_timeout)
        except ValueError as failure:
            error = str(failure)
        except asyncio.TimeoutError:
            import logging
            logging.getLogger(__name__).warning("Physics timeout match_id=%s command_id=%s", match_id, pending["command"]["commandId"])
            error = "Расчёт удара занял слишком много времени; ход восстановлен"
        except Exception:
            import logging
            logging.getLogger(__name__).exception("Physics calculation failed match_id=%s command_id=%s", match_id, pending["command"]["commandId"])
            # Do not expose internal paths or launch/session credentials in errors.
            error = "Ошибка расчёта удара; ход восстановлен"
        wall_seconds = time.perf_counter() - started
        command_id = pending["command"]["commandId"]
        async with self.lock:
            match, current_physics, current_pending = self._match(match_id)
            if match["status"] != "calculating" or not current_pending or current_pending["command"]["commandId"] != command_id:
                response = {"match": self.public_match(match), "duplicate": False, "cancelled": True}
                with self.store.transaction() as db:
                    db.execute("UPDATE commands SET status='done',response=? WHERE match_id=? AND command_id=?", (encode(response), match_id, command_id))
                return response
            match["revision"] += 1
            room = self._room_id(match["roomId"])
            with self.store.transaction() as db:
                if error:
                    match["status"] = "active"
                    match["deadline"] = utc(self.now() + pending.get("remainingSeconds", room["settings"]["turnSeconds"]))
                    self._save_match(db, match, current_physics)
                    db.execute("UPDATE commands SET status='rejected',response=? WHERE match_id=? AND command_id=?",
                               (encode({"detail": error}), match_id, command_id))
                    self._event(db, "shotRejected", player=pending["userId"], session=pending["session"]["id"], match=match,
                                client_version=pending["session"]["clientVersion"], turn_id=pending.get("turn", match["turn"]),
                                payload={"commandId": command_id, "reason": error, "wallDuration": wall_seconds})
                else:
                    rules = result["rules"]
                    match["status"] = "active"
                    match["snapshot"] = result["state"]["snapshot"]
                    match["currentPlayer"] = rules["nextPlayer"]
                    match["turn"] += 1
                    # The next legal shot begins after the server-defined animation.
                    playback_seconds = max(0, min(float(result["duration"]), 120))
                    playback_start = self.now() + 0.35
                    match["playbackUntil"] = utc(playback_start + playback_seconds)
                    match["deadline"] = utc(playback_start + playback_seconds + room["settings"]["turnSeconds"])
                    public_result = {key: value for key, value in result.items() if key not in {"state", "trajectories"}}
                    public_result["wallDuration"] = wall_seconds
                    public_result["commandId"] = command_id
                    public_result["playerId"] = pending["userId"]
                    public_result["turnId"] = pending.get("turn", match["turn"] - 1)
                    public_result["shotId"] = command_id
                    public_result["playbackStartAt"] = round(playback_start * 1000)
                    match["lastShot"] = {"commandId": command_id, "shotId": command_id,
                                         "playerId": pending["userId"], "startedAt": utc(playback_start),
                                         "startAt": round(playback_start * 1000), "turnId": public_result["turnId"], "result": public_result}
                    if rules.get("winner") is not None:
                        self._finish(db, match, result["state"], rules["winner"], "eightBall")
                    else:
                        self._save_match(db, match, result["state"])
                    self._event(db, "shotResult", player=pending["userId"], session=pending["session"]["id"], match=match,
                                client_version=pending["session"]["clientVersion"], event_id=f"shot:{match_id}:{command_id}",
                                turn_id=public_result["turnId"],
                                payload={"commandId": command_id, "events": result["events"], "potted": result.get("potted", []),
                                         "rules": rules, "wallDuration": wall_seconds, "simulatedDuration": result["duration"]})
                    response_match = self.public_match(match)
                    response_match["lastShot"].pop("result", None)
                    response = {"match": response_match, "result": public_result, "duplicate": False}
                    db.execute("UPDATE commands SET status='done',response=? WHERE match_id=? AND command_id=?", (encode(response), match_id, command_id))
        await self.announce_match(match, public_result if result is not None and not error else None)
        if error:
            raise HTTPException(422, error)
        return response

    def queue_status(self, user_id):
        row = self.store.db.execute("SELECT * FROM matchmaking WHERE user_id=?", (user_id,)).fetchone()
        if row:
            waited = self.now() - row["entered_at"]
            return {"queued": True, "mode": row["mode"], "enteredAt": utc(row["entered_at"]),
                    "ratingWindow": min(1000, 100 + int(waited // 10) * 100)}
        room = self._membership(user_id)
        return {"queued": False, **({"room": room, "matchId": room["matchId"]} if room and room["matchId"] else {})}

    async def enqueue(self, user_id, mode):
        async with self.lock:
            self._ensure_free(user_id)
            existing = self.store.db.execute("SELECT mode FROM matchmaking WHERE user_id=?", (user_id,)).fetchone()
            with self.store.transaction() as db:
                if not existing or existing["mode"] != mode:
                    db.execute("INSERT OR REPLACE INTO matchmaking VALUES(?,?,?,?)", (user_id, mode, self.now(), self._user(user_id)["elo"]))
        await self.pair_queued()
        return self.queue_status(user_id)

    async def cancel_queue(self, user_id):
        async with self.lock:
            with self.store.transaction() as db:
                db.execute("DELETE FROM matchmaking WHERE user_id=?", (user_id,))
        return {"queued": False}

    async def pair_queued(self):
        created = []
        async with self.lock:
            entries = list(self.store.db.execute("SELECT * FROM matchmaking ORDER BY entered_at"))
            used = set()
            with self.store.transaction() as db:
                for first in entries:
                    if first["user_id"] in used:
                        continue
                    if self._membership(first["user_id"]):
                        db.execute("DELETE FROM matchmaking WHERE user_id=?", (first["user_id"],))
                        continue
                    for second in entries:
                        if second["user_id"] == first["user_id"] or second["user_id"] in used or second["mode"] != first["mode"]:
                            continue
                        if self._membership(second["user_id"]):
                            continue
                        window = min(1000, 100 + int(max(self.now() - first["entered_at"], self.now() - second["entered_at"]) // 10) * 100)
                        if first["mode"] == "ranked" and abs(first["elo"] - second["elo"]) > window:
                            continue
                        players = [{"id": u["id"], "displayName": u["displayName"], "elo": u["elo"], "ready": True}
                                   for u in (self._user(first["user_id"]), self._user(second["user_id"]))]
                        room = self._new_room(first["user_id"], {"turnSeconds": 60, "ranked": first["mode"] == "ranked"}, players=players, matchmaking=True)
                        self._save_room(db, room)
                        match = self._start(db, room)
                        for player in players:
                            db.execute("DELETE FROM matchmaking WHERE user_id=?", (player["id"],))
                            used.add(player["id"])
                        created.append((room, match))
                        break
        for room, match in created:
            await self.emit(self._recipients(room), {"type": "matchmaking", "queued": False, "room": room, "matchId": match["id"]})
            await self.announce_room(room)
            await self.announce_match(match)

    async def connect(self, user_id, session):
        async with self.lock:
            self.connected[user_id] = self.connected.get(user_id, 0) + 1
            room = self._membership(user_id)
            match = None
            if room and room["matchId"]:
                match, physics, pending = self._match(room["matchId"])
                if user_id in match["disconnected"]:
                    del match["disconnected"][user_id]
                    with self.store.transaction() as db:
                        self._save_match(db, match, physics, pending)
                        self._event(db, "reconnect", player=user_id, session=session["id"], match=match, client_version=session["clientVersion"])
        if room:
            await self.announce_room(room)
        if match:
            await self.announce_match(match)
        return {"room": room, "match": self.public_match(match) if match else None, "queue": self.queue_status(user_id)}

    async def disconnect(self, user_id, session):
        match = None
        async with self.lock:
            self.connected[user_id] = max(0, self.connected.get(user_id, 1) - 1)
            if self.connected[user_id]:
                return
            room = self._membership(user_id)
            if room is None:
                with self.store.transaction() as db:
                    db.execute("DELETE FROM matchmaking WHERE user_id=?", (user_id,))
            if room and room["matchId"]:
                match, physics, pending = self._match(room["matchId"])
                if match["status"] != "finished" and any(p["id"] == user_id for p in match["players"]):
                    match["disconnected"][user_id] = self.now()
                    with self.store.transaction() as db:
                        self._save_match(db, match, physics, pending)
                        self._event(db, "disconnect", player=user_id, session=session["id"], match=match,
                                    payload={"graceSeconds": self.grace}, client_version=session["clientVersion"])
                else:
                    match = None
        if match:
            await self.announce_match(match)

    async def recover(self):
        jobs = []
        async with self.lock:
            with self.store.transaction() as db:
                for row in self._active_rows():
                    match, physics = decode(row["payload"]), decode(row["physics"])
                    if match["status"] == "finished":
                        continue
                    pending = decode(row["pending"]) if row["pending"] else None
                    if pending:
                        pending["startedAt"] = self.now()
                    # All clients have a full grace window after a server restart.
                    match["disconnected"] = {p["id"]: self.now() for p in match["players"]}
                    if match["status"] == "active":
                        room = self._room_id(match["roomId"])
                        match["deadline"] = utc(self.now() + max(self.grace, room["settings"]["turnSeconds"]))
                    self._save_match(db, match, physics, pending)
                    self._event(db, "serverRecovery", match=match)
                    if match["status"] == "calculating" and pending:
                        jobs.append((match["id"], physics, pending))
                    elif match["status"] == "calculating":
                        match["status"] = "active"
                        match["deadline"] = utc(self.now() + 60)
                        self._save_match(db, match, physics)
        for args in jobs:
            self._spawn(self._calculate(*args))

    async def tick(self):
        changed = []
        expired_rooms = []
        async with self.lock:
            with self.store.transaction() as db:
                for row in self._active_rows():
                    match, physics = decode(row["payload"]), decode(row["physics"])
                    pending = decode(row["pending"]) if row["pending"] else None
                    if match["status"] == "finished":
                        continue
                    elapsed_disconnects = [i for i, p in enumerate(match["players"])
                                           if self.now() - match["disconnected"].get(p["id"], self.now()) >= self.grace]
                    reason = None
                    winner = None
                    if len(elapsed_disconnects) == 2:
                        reason = "abandoned"
                    elif len(elapsed_disconnects) == 1:
                        reason, winner = "disconnect", 1 - elapsed_disconnects[0]
                    elif self.now() - epoch(match["startedAt"]) > self.max_match_seconds:
                        reason = "maximumDuration"
                    if reason:
                        match["revision"] += 1
                        self._finish(db, match, physics, winner, reason)
                        changed.append(match)
                    elif match["status"] == "calculating" and pending and self.now() - pending["startedAt"] > self.compute_timeout + 10:
                        # Recover even if the orchestration task itself failed unexpectedly.
                        match["status"] = "active"
                        match["revision"] += 1
                        match["deadline"] = utc(self.now() + pending.get("remainingSeconds", 60))
                        self._save_match(db, match, physics)
                        db.execute("UPDATE commands SET status='rejected',response=? WHERE match_id=? AND command_id=?",
                                   (encode({"detail": "Зависший расчёт сброшен; повторите удар"}), match["id"], pending["command"]["commandId"]))
                        self._event(db, "stalledCalculationRecovered", match=match, payload={"commandId": pending["command"]["commandId"]})
                        changed.append(match)
                    elif match["status"] == "active" and epoch(match["deadline"]) <= self.now():
                        shooter = match["currentPlayer"]
                        physics = self.engine.timeout(physics, shooter=shooter)
                        match["revision"] += 1
                        match["turn"] += 1
                        match["snapshot"] = physics["snapshot"]
                        match["currentPlayer"] = physics["snapshot"]["currentPlayer"]
                        room = self._room_id(match["roomId"])
                        match["deadline"] = utc(self.now() + room["settings"]["turnSeconds"])
                        match["playbackUntil"] = None
                        self._save_match(db, match, physics)
                        self._event(db, "turnTimeout", player=match["players"][shooter]["id"], match=match,
                                    payload={"nextPlayer": match["currentPlayer"]})
                        changed.append(match)
                stale_finished = {row["id"] for row in db.execute(
                    "SELECT id FROM rooms WHERE json_extract(payload,'$.status')='finished' AND updated_at<?",
                    (self.now() - self.room_ttl,))}
                for room in self._rooms("open", "finished"):
                    # Abandoned lobbies and long-finished result screens are closed, so
                    # the set of live rooms stays proportional to the online players.
                    if (room["status"] == "open" and self.now() - epoch(room["createdAt"]) > self.room_ttl) or room["id"] in stale_finished:
                        room["status"] = "closed"
                        self._save_room(db, room)
                        expired_rooms.append(room)
                db.execute("DELETE FROM sessions WHERE expires_at<?", (self.now(),))
        for match in changed:
            await self.announce_match(match)
        for room in expired_rooms:
            await self.announce_room(room)
        await self.pair_queued()

    async def run_timer(self):
        while not self.closed:
            await asyncio.sleep(1)
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                # A timer failure must not erase the durable match state.
                import logging
                logging.getLogger(__name__).exception("Match maintenance failed")

    def history(self, user_id, limit=50):
        result = []
        query = """SELECT matches.payload FROM match_players JOIN matches ON matches.id=match_players.match_id
                   WHERE match_players.user_id=? AND json_extract(matches.payload,'$.status')='finished'
                   ORDER BY matches.updated_at DESC LIMIT ?"""
        for row in self.store.db.execute(query, (user_id, limit)):
            match = decode(row["payload"])
            if match["status"] == "finished" and any(p["id"] == user_id for p in match["players"]):
                item = self.public_match(match)
                item.pop("lastShot", None)
                item.pop("snapshot", None)
                rating = next((r for r in match.get("ratings", []) if r["playerId"] == user_id), None)
                item["eloDelta"] = rating["delta"] if rating and match.get("ranked") else None
                item["opponentName"] = next((p["displayName"] for p in match["players"] if p["id"] != user_id), None)
                result.append(item)
                if len(result) >= limit:
                    break
        return {"matches": result}

    async def client_events(self, session, events):
        accepted = 0
        async with self.lock:
            with self.store.transaction() as db:
                for event in events:
                    match = None
                    if event.get("matchId"):
                        match = self.authorize_match(event["matchId"], session["userId"])[0]
                    before = db.total_changes
                    self._event(db, event["type"], player=session["userId"], session=session["id"], match=match,
                                event_id=f"client:{session['userId']}:{event['eventId']}", client_version=session["clientVersion"],
                                turn_id=event.get("turnId"),
                                payload={"clientTime": event.get("clientTime"), "data": event.get("payload", {})})
                    accepted += db.total_changes - before
        return {"accepted": accepted, "duplicates": len(events) - accepted}

    def telemetry(self, match_id, user_id, limit=1000):
        self.authorize_match(match_id, user_id, participant=True)
        rows = self.store.db.execute("SELECT * FROM telemetry WHERE match_id=? ORDER BY timestamp,event_id LIMIT ?", (match_id, limit))
        return {"matchId": match_id, "events": [{"id": row["event_id"], "type": row["type"], "playerId": row["player_id"],
                    "sessionId": row["session_id"], "matchId": row["match_id"], "turnId": row["turn_id"],
                    "clientVersion": row["client_version"], "timestamp": row["timestamp"], "data": decode(row["payload"])} for row in rows]}

    async def close(self):
        self.closed = True
        for task in tuple(self.tasks):
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        if self.pool:
            self.pool.close()
        self.store.close()
