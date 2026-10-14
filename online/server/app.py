"""Run with: uvicorn online.server.app:app --host 0.0.0.0 --port 8790."""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .auth import verify_vk_launch_params
from .service import GameService
from .storage import Store, encode


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class GuestLogin(StrictModel):
    displayName: str = Field(default="Гость", min_length=1, max_length=32)
    clientVersion: str = Field(default="unknown", max_length=64)

    @field_validator("displayName")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value or any(ord(char) < 32 for char in value):
            raise ValueError("Имя должно содержать видимые символы")
        return value


class VkLogin(StrictModel):
    launchParams: str = Field(min_length=1, max_length=8192)
    clientVersion: str = Field(default="unknown", max_length=64)


class ProfilePatch(StrictModel):
    displayName: str = Field(min_length=1, max_length=32)

    _clean = field_validator("displayName")(GuestLogin.clean_name.__func__)


class RoomSettings(StrictModel):
    turnSeconds: int = Field(default=60, ge=15, le=180)
    ranked: bool = False


class RoomCreate(StrictModel):
    settings: RoomSettings = Field(default_factory=RoomSettings)
    clientVersion: str | None = Field(default=None, max_length=64)


class RoomSettingsPatch(StrictModel):
    turnSeconds: int | None = Field(default=None, ge=15, le=180)
    ranked: bool | None = None


class Ready(StrictModel):
    ready: bool = True


class SoloRequest(StrictModel):
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    turnSeconds: int = Field(default=60, ge=15, le=180)


class QueueRequest(StrictModel):
    mode: Literal["casual", "ranked"]


class Command(StrictModel):
    commandId: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    expectedRevision: int = Field(ge=0)
    type: Literal["shot", "placeCueBall", "surrender"]
    payload: dict = Field(default_factory=dict)

    @field_validator("payload")
    @classmethod
    def bounded_payload(cls, value):
        if len(encode(value)) > 2048:
            raise ValueError("Слишком большая команда")
        return value


class Shot(StrictModel):
    V0: float = Field(ge=0.05, le=8)
    phi: float = Field(ge=0, lt=360)
    theta: float = Field(default=0, ge=0, le=60)
    a: float = Field(default=0, ge=-0.9, le=0.9)
    b: float = Field(default=0, ge=-0.9, le=0.9)
    ballCall: str | None = Field(default=None, max_length=16)
    pocketCall: str | None = Field(default=None, max_length=16)


class Placement(StrictModel):
    x: float
    y: float


class ClientEvent(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    type: Literal["clientError", "clientPerformance", "clientVisibility", "clientReconnect"]
    clientVersion: str = Field(default="unknown", max_length=64)
    timestamp: str | None = Field(default=None, max_length=64)
    matchId: str | None = Field(default=None, max_length=64)
    turnId: int | None = Field(default=None, ge=0)
    data: dict = Field(default_factory=dict)

    @field_validator("data")
    @classmethod
    def safe_data(cls, value):
        allowed = {"message", "code", "fps", "latencyMs", "width", "height", "visibility", "durationMs", "count", "reason", "connected", "visible", "drawCalls", "triangles"}
        if set(value) - allowed or len(encode(value)) > 4096:
            raise ValueError("Неизвестные или слишком большие поля телеметрии")
        if any(isinstance(item, (list, dict)) for item in value.values()):
            raise ValueError("Значения телеметрии должны быть скалярными")
        for key, item in value.items():
            if isinstance(item, str):
                # Error strings sometimes contain request headers; remove credentials.
                value[key] = re.sub(r"(?i)bearer\s+\S+|[A-Za-z0-9_-]{40,}", "[redacted]", item)
        return value


class ClientEvents(StrictModel):
    events: list[ClientEvent] = Field(max_length=50)


class Hub:
    def __init__(self):
        self.sockets: dict[str, set[WebSocket]] = defaultdict(set)
        self.locks: dict[WebSocket, asyncio.Lock] = {}

    async def send(self, socket, data):
        try:
            async with self.locks[socket]:
                await asyncio.wait_for(socket.send_json(data), timeout=5)
        except (RuntimeError, WebSocketDisconnect, asyncio.TimeoutError):
            # Reconnect must restore a client that missed a state transition.
            try:
                await asyncio.wait_for(socket.close(code=1013, reason="Reconnect to restore match state"), timeout=1)
            except (RuntimeError, WebSocketDisconnect, asyncio.TimeoutError):
                pass
            return False
        return True

    async def emit(self, recipients, data):
        sockets = {socket for user_id in recipients for socket in self.sockets.get(user_id, ())}
        if sockets:
            await asyncio.gather(*(self.send(socket, data) for socket in sockets), return_exceptions=True)


class RateLimiter:
    def __init__(self):
        self.entries = defaultdict(deque)

    def check(self, key, count=60, seconds=60):
        now = time.monotonic()
        history = self.entries[key]
        while history and history[0] < now - seconds:
            history.popleft()
        if len(history) >= count:
            raise HTTPException(429, "Слишком много запросов; повторите чуть позже")
        history.append(now)
        if len(self.entries) > 10000:
            self.entries = defaultdict(deque, {k: v for k, v in self.entries.items() if v and v[-1] > now - 60})


def create_app(*, database=None, engine=None, process_pool=True, now=time.time, background=True):
    hub = Hub()
    limiter = RateLimiter()

    @asynccontextmanager
    async def lifespan(application):
        store = Store(database or os.getenv("POOLTOOL_DB", "online/data/pooltool.sqlite3"))
        service = None
        application.state.engine_error = None
        try:
            physics_engine = engine
            if physics_engine is None:
                from .physics import PhysicsEngine

                physics_engine = PhysicsEngine()
                physics_engine.new_match(seed=0)  # Fail readiness if the real engine cannot initialize.
                await asyncio.to_thread(physics_engine.warmup)
            service = GameService(store, physics_engine, process_pool=process_pool, now=now)
            service.emit = hub.emit
            application.state.service = service
            if service.pool:
                service.pool.start()  # Warm workers before the first shot arrives.
            await service.recover()
            timer = service._spawn(service.run_timer()) if background else None
        except Exception as error:
            import logging
            logging.getLogger(__name__).exception("Pooltool physics initialization failed")
            application.state.engine_error = type(error).__name__
            application.state.service = None
            timer = None
        yield
        if timer:
            timer.cancel()
        if service:
            await service.close()
        else:
            store.close()

    application = FastAPI(title="Pooltool Online", version="1.0.0", lifespan=lifespan)
    application.add_middleware(GZipMiddleware, minimum_size=1000)
    origins = [value.strip() for value in os.getenv("CORS_ORIGINS", "").split(",") if value.strip()]
    if origins:
        application.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["Authorization", "Content-Type"])

    @application.middleware("http")
    async def safe_headers(request, call_next):
        if request.headers.get("content-length", "0").isdigit() and int(request.headers.get("content-length", "0")) > 65536:
            return JSONResponse({"detail": "Слишком большой запрос"}, status_code=413)
        response = await call_next(request)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    async def service(request: Request) -> GameService:
        current = request.app.state.service
        if current is None:
            raise HTTPException(503, "Физический движок ещё не готов")
        return current

    async def session(request: Request, current=Depends(service)):
        header = request.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            raise HTTPException(401, "Требуется токен сессии")
        identity = current.session(header[7:])
        limiter.check(f"user:{identity['userId']}", count=120)
        return identity

    @application.get("/health")
    @application.get("/api/health")
    def health(request: Request):
        ready = request.app.state.service is not None
        return JSONResponse({"status": "ok" if ready else "not_ready", "physics": "pooltool" if ready else "unavailable",
                             "engineError": request.app.state.engine_error}, status_code=200 if ready else 503)

    @application.get("/ready")
    def ready(request: Request):
        # Not ready for traffic until a warm physics worker can take the first shot.
        current = request.app.state.service
        warm = current.pool.warm_count if current and current.pool else None
        if current is not None and warm == 0:
            return JSONResponse({"status": "warming", "physics": "pooltool", "warmWorkers": 0}, status_code=503)
        return health(request)

    @application.post("/api/auth/guest")
    async def guest(body: GuestLogin, request: Request, current=Depends(service)):
        limiter.check(f"guest:{request.client.host if request.client else 'unknown'}", count=int(os.getenv("GUEST_LOGINS_PER_MINUTE", "20")))
        return await current.authenticate(body.displayName, body.clientVersion)

    @application.post("/api/auth/vk")
    async def vk(body: VkLogin, request: Request, current=Depends(service)):
        limiter.check(f"vk:{request.client.host if request.client else 'unknown'}", count=30)
        vk_id = verify_vk_launch_params(body.launchParams, current.now())
        return await current.authenticate(f"Игрок VK {vk_id}", body.clientVersion, vk_id)

    @application.get("/api/me")
    async def me(identity=Depends(session), current=Depends(service)):
        return {"user": current._user(identity["userId"])}

    @application.patch("/api/me")
    async def profile(body: ProfilePatch, identity=Depends(session), current=Depends(service)):
        return {"user": await current.update_profile(identity["userId"], display_name=body.displayName)}

    @application.get("/api/me/settings")
    async def settings(identity=Depends(session), current=Depends(service)):
        return {"settings": current._user(identity["userId"])["settings"]}

    @application.put("/api/me/settings")
    async def save_settings(body: dict, identity=Depends(session), current=Depends(service)):
        values = body.get("settings", body)
        try:
            encoded = encode(values)
        except (ValueError, TypeError):
            raise HTTPException(422, "Настройки содержат некорректные значения") from None
        if not isinstance(values, dict) or len(encoded.encode("utf-8")) > 16384:
            raise HTTPException(422, "Настройки должны быть объектом меньше 16 КиБ")
        user = await current.update_profile(identity["userId"], settings=values)
        return {"settings": user["settings"]}

    @application.get("/api/me/history")
    async def history(limit: int = 50, identity=Depends(session), current=Depends(service)):
        return current.history(identity["userId"], max(1, min(limit, 100)))

    @application.get("/api/me/current")
    async def current_room(identity=Depends(session), current=Depends(service)):
        room = current._membership(identity["userId"])
        return {"room": room, "match": current.public_match(current._match(room["matchId"])[0]) if room and room["matchId"] else None,
                "queue": current.queue_status(identity["userId"])}

    @application.post("/api/rooms")
    async def create_room(body: RoomCreate, identity=Depends(session), current=Depends(service)):
        if body.settings.ranked:
            raise HTTPException(422, "Рейтинговые матчи создаются только через рейтинговый поиск")
        return await current.create_room(identity["userId"], body.settings.model_dump())

    @application.get("/api/rooms/{code}")
    async def get_room(code: str, identity=Depends(session), current=Depends(service)):
        room = current._room(code)
        if identity["userId"] not in current._recipients(room):
            # A preview allows joining by code, without exposing match internals.
            return {"room": {key: room[key] for key in ("code", "status", "settings")}, "playerCount": len(room["players"])}
        return {"room": room}

    @application.post("/api/rooms/{code}/join")
    async def join(code: str, identity=Depends(session), current=Depends(service)):
        return await current.join_room(code, identity["userId"])

    @application.post("/api/rooms/{code}/spectate")
    async def spectate(code: str, identity=Depends(session), current=Depends(service)):
        return await current.join_room(code, identity["userId"], spectate=True)

    @application.patch("/api/rooms/{code}/settings")
    async def configure(code: str, body: RoomSettingsPatch, identity=Depends(session), current=Depends(service)):
        return await current.configure_room(code, identity["userId"], body.model_dump(exclude_none=True))

    @application.post("/api/rooms/{code}/ready")
    async def player_ready(code: str, body: Ready, identity=Depends(session), current=Depends(service)):
        return await current.ready_room(code, identity["userId"], body.ready)

    @application.post("/api/rooms/{code}/start")
    async def start(code: str, identity=Depends(session), current=Depends(service)):
        return await current.ready_room(code, identity["userId"], start=True)

    @application.post("/api/rooms/{code}/leave")
    async def leave(code: str, identity=Depends(session), current=Depends(service)):
        return await current.leave_room(code, identity["userId"])

    @application.post("/api/solo")
    async def solo(body: SoloRequest, identity=Depends(session), current=Depends(service)):
        return await current.create_solo(identity["userId"], body.difficulty, body.turnSeconds)

    @application.post("/api/matchmaking")
    async def queue(body: QueueRequest, identity=Depends(session), current=Depends(service)):
        return await current.enqueue(identity["userId"], body.mode)

    @application.get("/api/matchmaking")
    async def queue_status(identity=Depends(session), current=Depends(service)):
        return current.queue_status(identity["userId"])

    @application.delete("/api/matchmaking")
    async def cancel_queue(identity=Depends(session), current=Depends(service)):
        return await current.cancel_queue(identity["userId"])

    @application.get("/api/matches/{match_id}")
    async def match(match_id: str, identity=Depends(session), current=Depends(service)):
        return {"match": current.public_match(current.authorize_match(match_id, identity["userId"])[0])}

    @application.post("/api/matches/{match_id}/commands")
    async def command(match_id: str, body: Command, identity=Depends(session), current=Depends(service)):
        try:
            if body.type == "shot":
                shot = Shot.model_validate(body.payload)
                if shot.a * shot.a + shot.b * shot.b > 0.81 + 1e-12:
                    raise ValueError("Точка удара вне битка")
                body.payload = shot.model_dump(exclude_none=True)
            elif body.type == "placeCueBall":
                body.payload = Placement.model_validate(body.payload).model_dump()
            elif body.payload:
                raise ValueError("Команда сдачи не принимает параметров")
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        return await current.command(match_id, identity["userId"], body.model_dump(), identity)

    @application.get("/api/matches/{match_id}/telemetry")
    async def match_telemetry(match_id: str, limit: int = 1000, identity=Depends(session), current=Depends(service)):
        return current.telemetry(match_id, identity["userId"], max(1, min(limit, 1000)))

    @application.post("/api/telemetry/events")
    async def telemetry(body: ClientEvents, identity=Depends(session), current=Depends(service)):
        mapped = [{"eventId": event.id, "type": event.type, "clientTime": event.timestamp,
                   "matchId": event.matchId, "turnId": event.turnId, "payload": event.data} for event in body.events]
        result = await current.client_events(identity, mapped)
        # Duplicate IDs are acknowledged too, so retries leave the client queue.
        return {**result, "acceptedIds": [event.id for event in body.events]}

    @application.websocket("/ws")
    async def websocket(socket: WebSocket):
        await socket.accept()
        current = socket.app.state.service
        user_id = None
        identity = None
        if current is None:
            await socket.close(code=1013, reason="Physics engine unavailable")
            return
        try:
            raw = await asyncio.wait_for(socket.receive_text(), timeout=10)
            if len(raw) > 2048:
                raise HTTPException(413, "Сообщение авторизации слишком большое")
            data = json.loads(raw)
            if data.get("type") != "auth":
                raise HTTPException(401, "Первое сообщение должно содержать авторизацию")
            identity = current.session(data.get("token", ""))
            user_id = identity["userId"]
            if len(hub.sockets[user_id]) >= 5:
                raise HTTPException(429, "Слишком много активных подключений")
            limiter.check(f"ws:{user_id}", count=20)
            hub.sockets[user_id].add(socket)
            hub.locks[socket] = asyncio.Lock()
            await hub.send(socket, {"type": "authenticated", "user": current._user(user_id), "serverTime": current.now() * 1000})
            restored = await current.connect(user_id, identity)
            await hub.send(socket, {"type": "restored", "serverTime": current.now() * 1000, **restored})
            while True:
                raw = await asyncio.wait_for(socket.receive_text(), timeout=45)
                if len(raw) > 4096:
                    await socket.close(code=1009)
                    break
                data = json.loads(raw)
                limiter.check(f"wsmsg:{user_id}", count=120)
                if data.get("type") == "ping":
                    await hub.send(socket, {"type": "pong", "serverTime": current.now() * 1000, "clientTime": data.get("clientTime")})
                elif data.get("type") == "sync":
                    room = current._membership(user_id)
                    await hub.send(socket, {"type": "restored", "room": room,
                                           "serverTime": current.now() * 1000,
                                           "match": current.public_match(current._match(room["matchId"])[0]) if room and room["matchId"] else None,
                                           "queue": current.queue_status(user_id)})
                else:
                    await hub.send(socket, {"type": "error", "detail": "Команды отправляются через HTTP API"})
        except HTTPException as error:
            await socket.close(code=1008, reason=str(error.detail)[:120])
        except (WebSocketDisconnect, asyncio.TimeoutError, json.JSONDecodeError, TypeError, AttributeError):
            pass
        finally:
            if user_id and socket in hub.sockets[user_id]:
                hub.sockets[user_id].remove(socket)
                hub.locks.pop(socket, None)
                await current.disconnect(user_id, identity)

    dist = Path(__file__).resolve().parents[1] / "client" / "dist"
    if dist.is_dir():
        application.mount("/", StaticFiles(directory=dist, html=True), name="client")
    return application


app = create_app()
