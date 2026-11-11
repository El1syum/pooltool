"""Shared cosmetic GLB library with separate, fail-closed administration.

Models never alter authoritative table dimensions or physics. Credentials are
configured by the operator, not inferred from a guest name or player profile.
The testing preview may use HTTP at the user's explicit request; cookies become
Secure automatically on HTTPS. Use a unique testing password on plain HTTP.
"""

from __future__ import annotations

import asyncio
import base64
from collections import OrderedDict, deque
from datetime import datetime, timezone
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import secrets
import struct
import tempfile
import time
from typing import Annotated, Literal
from urllib.parse import urlsplit
import uuid

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .storage import Store, decode, encode


MAX_MODEL_BYTES = 50 * 1024 * 1024
MAX_GLB_JSON_BYTES = 8 * 1024 * 1024
MAX_LIBRARY_BYTES = 2 * 1024 * 1024 * 1024
MAX_LIBRARY_ASSETS = 500
MAX_METADATA_BYTES = 65536
MAX_MODEL_NODES = 3000
MAX_MODEL_VERTICES = 1_000_000
ADMIN_COOKIE = "pooltool_asset_admin"
ADMIN_COOKIE_PATH = "/api/assets"
ADMIN_SESSION_SECONDS = 8 * 60 * 60
CSRF_HEADER = "X-Asset-CSRF"
ASSET_ID = re.compile(r"^[0-9a-f]{32}$")
SESSION_TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")
ROLES = ("table", "environment")


def _utc(value: float) -> str:
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def _reject_json_constant(_):
    raise ValueError("JSON contains a non-finite number")


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,100}", value):
        raise ValueError("Malformed password hash")
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def hash_admin_password(password: str, *, salt: bytes | None = None) -> str:
    """Operator helper. Return a scrypt hash; never persist the plaintext input."""
    if not isinstance(password, str) or not 12 <= len(password) <= 256:
        raise ValueError("Use a unique password of 12–256 characters")
    salt = salt if salt is not None else secrets.token_bytes(16)
    if not 16 <= len(salt) <= 32:
        raise ValueError("Salt must contain 16–32 bytes")
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return f"scrypt$16384$8$1${_b64(salt)}${_b64(digest)}"


def _password_parts(value: str) -> tuple[bytes, bytes] | None:
    try:
        kind, n, r, p, salt, digest = value.split("$")
        if (kind, n, r, p) != ("scrypt", "16384", "8", "1"):
            return None
        salt_bytes, digest_bytes = _unb64(salt), _unb64(digest)
        if not 16 <= len(salt_bytes) <= 32 or len(digest_bytes) != 32:
            return None
        return salt_bytes, digest_bytes
    except (ValueError, TypeError):
        return None


def verify_admin_password(password: str, password_hash: str) -> bool:
    parts = _password_parts(password_hash)
    if parts is None:
        return False
    salt, expected = parts
    actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=16384, r=8, p=1, dklen=32)
    return hmac.compare_digest(actual, expected)


class StrictAssetModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class AdminLogin(StrictAssetModel):
    username: str = Field(min_length=1, max_length=160)
    password: str = Field(min_length=1, max_length=256)


Coordinate = Annotated[float, Field(ge=-100, le=100, strict=True)]
Rotation = Annotated[float, Field(ge=-3600, le=3600, strict=True)]
Scale = Annotated[float, Field(ge=0.0001, le=1000, strict=True)]
Colour = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]
Unit = Annotated[float, Field(ge=0, le=1, strict=True)]


def _name(value: str) -> str:
    value = value.strip()
    if not value or len(value) > 160 or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("Название должно содержать 1–160 видимых символов")
    return value


class MaterialOverride(StrictAssetModel):
    color: Colour | None = None
    roughness: Unit | None = None
    metalness: Unit | None = None
    emissive: Colour | None = None
    emissiveIntensity: Annotated[float, Field(ge=0, le=10, strict=True)] | None = None


class ModelConfiguration(StrictAssetModel):
    position: tuple[Coordinate, Coordinate, Coordinate] = (0, 0, 0)
    rotation: tuple[Rotation, Rotation, Rotation] = (0, 0, 0)
    scale: tuple[Scale, Scale, Scale] = (1, 1, 1)
    replaceProcedural: bool = Field(default=True, strict=True)
    material: MaterialOverride = Field(default_factory=MaterialOverride)
    materials: dict[str, MaterialOverride] = Field(default_factory=dict, max_length=300)
    hiddenNodes: list[str] = Field(default_factory=list, max_length=MAX_MODEL_NODES)

    @field_validator("materials")
    @classmethod
    def material_names(cls, values):
        for name in values:
            _name(name)
            if name in ("__proto__", "constructor", "prototype"):
                raise ValueError("Имя материала зарезервировано")
        return values

    @field_validator("hiddenNodes")
    @classmethod
    def node_names(cls, values):
        for value in values:
            _name(value)
        return list(dict.fromkeys(values))


class AssetUpdate(StrictAssetModel):
    name: str | None = None
    role: Literal["table", "environment"] | None = None
    enabled: bool | None = Field(default=None, strict=True)
    config: ModelConfiguration | None = None
    expectedVersion: int | None = Field(default=None, ge=0)

    @field_validator("name")
    @classmethod
    def display_name(cls, value):
        return _name(value) if value is not None else None


class ProfileUpdate(StrictAssetModel):
    tableId: str | None
    environmentId: str | None
    configs: dict[str, ModelConfiguration] = Field(default_factory=dict, max_length=2)
    names: dict[str, str] = Field(default_factory=dict, max_length=2)
    expectedVersion: int | None = Field(default=None, ge=0)

    @field_validator("names")
    @classmethod
    def display_names(cls, values):
        return {asset_id: _name(value) for asset_id, value in values.items()}


def validate_glb_file(path: Path, byte_length: int) -> None:
    """Validate self-contained GLB 2 before publishing it as a public resource."""
    if byte_length < 20 or byte_length > MAX_MODEL_BYTES:
        raise ValueError("Нужен самодостаточный GLB до 50 МБ")
    document = None
    bin_length = None
    with path.open("rb") as stream:
        magic, version, total = struct.unpack("<4sII", stream.read(12))
        if magic != b"glTF" or version != 2 or total != byte_length:
            raise ValueError("Файл не является корректным GLB 2.0")
        offset, chunks = 12, 0
        while offset < byte_length:
            header = stream.read(8)
            if len(header) != 8:
                raise ValueError("Повреждён заголовок блока GLB")
            size, kind = struct.unpack("<II", header)
            offset += 8
            if size % 4 or offset + size > byte_length:
                raise ValueError("Повреждена длина блока GLB")
            if chunks == 0 and kind != 0x4E4F534A:
                raise ValueError("Первым блоком GLB должен быть JSON")
            if kind == 0x4E4F534A:
                if document is not None or size > MAX_GLB_JSON_BYTES:
                    raise ValueError("Некорректный JSON-блок GLB")
                try:
                    raw = stream.read(size).decode("utf-8").rstrip("\x00 \t\r\n")
                    document = json.loads(raw, parse_constant=_reject_json_constant)
                except (ValueError, UnicodeDecodeError, RecursionError):
                    raise ValueError("Не удалось прочитать JSON модели") from None
            elif kind == 0x004E4942 and bin_length is None:
                bin_length = size
                stream.seek(size, 1)
            else:
                raise ValueError("Неподдерживаемый или повторный блок GLB")
            offset += size
            chunks += 1
    if not isinstance(document, dict) or not isinstance(document.get("asset"), dict) or document["asset"].get("version") != "2.0":
        raise ValueError("Требуется glTF 2.0")

    def walk(value, depth=0):
        if depth > 80:
            raise ValueError("Слишком глубокая структура GLB")
        if isinstance(value, dict):
            for key, entry in value.items():
                if key.lower() == "uri" and (not isinstance(entry, str) or not entry.startswith("data:")):
                    raise ValueError("Внешние файлы запрещены: встройте все текстуры в GLB")
                walk(entry, depth + 1)
        elif isinstance(value, list):
            for entry in value:
                walk(entry, depth + 1)
        elif isinstance(value, float) and not math.isfinite(value):
            raise ValueError("GLB содержит некорректное число")

    walk(document)
    buffers = document.get("buffers", [])
    if not isinstance(buffers, list) or len(buffers) > 64:
        raise ValueError("Некорректные буферы GLB")
    for index, buffer in enumerate(buffers):
        if not isinstance(buffer, dict):
            raise ValueError("Некорректный буфер GLB")
        length = buffer.get("byteLength")
        if isinstance(length, bool) or not isinstance(length, int) or not 0 <= length <= MAX_MODEL_BYTES:
            raise ValueError("Некорректная длина буфера GLB")
        if "uri" not in buffer and (index != 0 or bin_length is None or not 0 <= bin_length - length <= 3):
            raise ValueError("Двоичный буфер GLB отсутствует или повреждён")
    views = document.get("bufferViews", [])
    if not isinstance(views, list):
        raise ValueError("Некорректные диапазоны буферов GLB")
    for view in views:
        if not isinstance(view, dict):
            raise ValueError("Некорректный диапазон буфера GLB")
        index, start, length = view.get("buffer"), view.get("byteOffset", 0), view.get("byteLength")
        if any(isinstance(value, bool) or not isinstance(value, int) for value in (index, start, length)):
            raise ValueError("Некорректный диапазон буфера GLB")
        if not 0 <= index < len(buffers) or start < 0 or length < 0 or start + length > buffers[index]["byteLength"]:
            raise ValueError("Диапазон GLB выходит за границы буфера")
    nodes = document.get("nodes", [])
    if not isinstance(nodes, list) or len(nodes) > MAX_MODEL_NODES:
        raise ValueError("В модели должно быть не более 3000 узлов")
    required = document.get("extensionsRequired", [])
    if not isinstance(required, list) or any(value in ("KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu") for value in required):
        raise ValueError("Пересохраните GLB без обязательных Draco/Meshopt/KTX2-декодеров")
    accessors, meshes = document.get("accessors", []), document.get("meshes", [])
    if not isinstance(accessors, list) or not isinstance(meshes, list) or not meshes:
        raise ValueError("GLB должен содержать геометрию")
    vertices = []
    for mesh in meshes:
        if not isinstance(mesh, dict) or not isinstance(mesh.get("primitives"), list):
            raise ValueError("Некорректная геометрия GLB")
        count = 0
        for primitive in mesh["primitives"]:
            attributes = primitive.get("attributes") if isinstance(primitive, dict) else None
            index = attributes.get("POSITION") if isinstance(attributes, dict) else None
            if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(accessors):
                raise ValueError("В геометрии отсутствуют координаты вершин")
            accessor = accessors[index]
            value = accessor.get("count") if isinstance(accessor, dict) else None
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_MODEL_VERTICES:
                raise ValueError("Некорректное число вершин GLB")
            count += value
        vertices.append(count)
    total_vertices = 0
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError("Некорректный узел GLB")
        if "mesh" in node:
            index = node["mesh"]
            if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(vertices):
                raise ValueError("Некорректная ссылка на геометрию")
            total_vertices += vertices[index]
    if not total_vertices:
        raise ValueError("Сцена GLB не содержит геометрии")
    if total_vertices > MAX_MODEL_VERTICES:
        raise ValueError("В модели больше 1 млн вершин с учётом экземпляров")
    colours = [0] * len(nodes)

    def visit(index, depth=0):
        if depth > 80 or colours[index] == 1:
            raise ValueError("Некорректная циклическая или слишком глубокая иерархия GLB")
        if colours[index] == 2:
            return
        colours[index] = 1
        children = nodes[index].get("children", [])
        if not isinstance(children, list):
            raise ValueError("Некорректная иерархия GLB")
        for child in children:
            if isinstance(child, bool) or not isinstance(child, int) or not 0 <= child < len(nodes):
                raise ValueError("Некорректная ссылка на узел GLB")
            visit(child, depth + 1)
        colours[index] = 2

    for index in range(len(nodes)):
        visit(index)


class LoginThrottle:
    def __init__(self, now):
        self.now = now
        self.failures = OrderedDict()

    def _keys(self, request, username):
        address = request.client.host if request.client else "unknown"
        name = hashlib.sha256(username.casefold().encode("utf-8")).hexdigest()
        return (("ip:" + address, 20), ("user:" + name, 5))

    def check(self, request, username):
        for key, limit in self._keys(request, username):
            entries = self.failures.get(key, ())
            while entries and entries[0] <= self.now() - 60:
                entries.popleft()
            if len(entries) >= limit:
                raise HTTPException(429, "Слишком много попыток входа; повторите через минуту", headers={"Retry-After": "60"})

    def failed(self, request, username):
        for key, _ in self._keys(request, username):
            entries = self.failures.setdefault(key, deque())
            entries.append(self.now())
            self.failures.move_to_end(key)
        while len(self.failures) > 4096:
            self.failures.popitem(last=False)

    def success(self, request, username):
        for key, _ in self._keys(request, username):
            self.failures.pop(key, None)


async def _body(request: Request, maximum: int, *, timeout=15) -> bytes:
    result = bytearray()
    try:
        async with asyncio.timeout(timeout):
            async for chunk in request.stream():
                if len(result) + len(chunk) > maximum:
                    raise HTTPException(413, "Слишком большой запрос")
                result.extend(chunk)
    except TimeoutError:
        raise HTTPException(408, "Истекло время передачи запроса") from None
    return bytes(result)


async def _json(request: Request, model, *, maximum=MAX_METADATA_BYTES):
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(415, "Требуется JSON")
    try:
        raw = await _body(request, maximum)
        value = json.loads(raw, parse_constant=_reject_json_constant)
        return model.model_validate(value)
    except ValidationError as error:
        # In particular, never echo a supplied administrator password.
        detail = [{"loc": entry["loc"], "msg": entry["msg"], "type": entry["type"]}
                  for entry in error.errors(include_input=False, include_url=False)]
        raise HTTPException(422, detail) from None
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise HTTPException(422, "Некорректный JSON") from None


async def _disk(function, *args):
    """Finish an in-flight disk operation before cancellation cleans its file."""
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


class AssetLibrary:
    def __init__(self, store: Store, root: Path, *, now=time.time):
        self.store, self.now = store, now
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.username = os.getenv("ASSET_ADMIN_USERNAME", "").strip()
        self.password_hash = os.getenv("ASSET_ADMIN_PASSWORD_HASH", "")
        self.credential_tag = hashlib.sha256((self.username + "\0" + self.password_hash).encode("utf-8")).hexdigest()
        self.throttle = LoginThrottle(now)
        self.login_lock = asyncio.Lock()
        self.upload_lock = asyncio.Lock()
        self.store.db.executescript("""
        CREATE TABLE IF NOT EXISTS model_assets(
            id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, name TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('table','environment')), byte_size INTEGER NOT NULL,
            config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
            created_at REAL NOT NULL, updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS asset_library_state(
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL,
            profile TEXT NOT NULL, updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS asset_admin_sessions(
            token_hash TEXT PRIMARY KEY, credential_tag TEXT NOT NULL,
            created_at REAL NOT NULL, expires_at REAL NOT NULL
        );
        """)
        self.store.db.execute("INSERT OR IGNORE INTO asset_library_state VALUES(1,0,?,?)",
                              (encode({"tableId": None, "environmentId": None}), self.now()))
        self.store.db.commit()

    @property
    def configured(self):
        return bool(self.username and _password_parts(self.password_hash))

    def same_origin(self, request):
        origin = request.headers.get("origin")
        if origin is None:
            return
        try:
            supplied, expected = urlsplit(origin), urlsplit(str(request.base_url))
            if supplied.username or supplied.password or supplied.path not in ("", "/") or supplied.query or supplied.fragment:
                raise ValueError
            if (supplied.scheme, supplied.hostname, supplied.port) != (expected.scheme, expected.hostname, expected.port):
                raise ValueError
        except ValueError:
            raise HTTPException(403, "Администрирование доступно только с сайта игры") from None

    def _csrf(self, token):
        return hmac.new(self.password_hash.encode("utf-8"), ("pooltool-assets-csrf:" + token).encode("ascii"), hashlib.sha256).hexdigest()

    def admin_session(self, request, *, required=True, mutation=False):
        self.same_origin(request)
        token = request.cookies.get(ADMIN_COOKIE, "")
        row = None
        if self.configured and SESSION_TOKEN.fullmatch(token):
            row = self.store.db.execute("SELECT * FROM asset_admin_sessions WHERE token_hash=?",
                                        (hashlib.sha256(token.encode("ascii")).hexdigest(),)).fetchone()
            if row and (row["expires_at"] <= self.now() or not hmac.compare_digest(row["credential_tag"], self.credential_tag)):
                row = None
        if row is None:
            if required:
                raise HTTPException(401, "Войдите как администратор библиотеки")
            return None
        csrf = self._csrf(token)
        supplied = request.headers.get(CSRF_HEADER, "")
        if mutation and (not re.fullmatch(r"[0-9a-f]{64}", supplied) or not hmac.compare_digest(supplied, csrf)):
            raise HTTPException(403, "Обновите сессию администратора: неверный CSRF-токен")
        return {"tokenHash": row["token_hash"], "csrfToken": csrf, "expiresAt": _utc(row["expires_at"])}

    def _state(self):
        return self.store.db.execute("SELECT * FROM asset_library_state WHERE singleton=1").fetchone()

    def _asset(self, asset_id, *, enabled_only=False):
        if not ASSET_ID.fullmatch(asset_id):
            raise HTTPException(404, "Модель не найдена")
        row = self.store.db.execute("SELECT * FROM model_assets WHERE id=?", (asset_id,)).fetchone()
        if row is None or (enabled_only and not row["enabled"]):
            raise HTTPException(404, "Модель не найдена")
        return row

    def _file(self, asset_id):
        if not ASSET_ID.fullmatch(asset_id):
            raise HTTPException(404, "Модель не найдена")
        path = (self.root / f"{asset_id}.glb").resolve()
        if path.parent != self.root:
            raise HTTPException(404, "Модель не найдена")
        return path

    def _view(self, row):
        return {"id": row["id"], "sha256": row["sha256"], "name": row["name"], "role": row["role"],
                "bytes": row["byte_size"], "enabled": bool(row["enabled"]), "config": decode(row["config"]),
                "url": f"/models/library/{row['id']}.glb", "createdAt": _utc(row["created_at"]), "updatedAt": _utc(row["updated_at"])}

    def snapshot(self, *, include_disabled=False):
        state = self._state()
        rows = self.store.db.execute("SELECT * FROM model_assets" + ("" if include_disabled else " WHERE enabled=1") + " ORDER BY created_at,id")
        return {"version": state["version"], "assets": [self._view(row) for row in rows],
                "profile": decode(state["profile"]), "updatedAt": _utc(state["updated_at"])}

    def _check_version(self, expected):
        if expected is not None and expected != self._state()["version"]:
            raise HTTPException(409, "Библиотека изменена другим администратором; обновите список")

    def _bump(self, db, *, profile=None):
        if profile is None:
            db.execute("UPDATE asset_library_state SET version=version+1,updated_at=? WHERE singleton=1", (self.now(),))
        else:
            db.execute("UPDATE asset_library_state SET version=version+1,profile=?,updated_at=? WHERE singleton=1", (encode(profile), self.now()))

    async def upload(self, request, *, name, role, expected_version=None):
        self.admin_session(request, mutation=True)
        try:
            name = _name(name)
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        if role not in ROLES:
            raise HTTPException(422, "Выберите роль table или environment")
        media = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if media not in ("application/octet-stream", "model/gltf-binary"):
            raise HTTPException(415, "Передайте файл GLB как model/gltf-binary или application/octet-stream")
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > MAX_MODEL_BYTES:
            raise HTTPException(413, "Модель превышает 50 МБ")
        async with self.upload_lock:
            self._check_version(expected_version)
            usage = self.store.db.execute("SELECT COUNT(*),COALESCE(SUM(byte_size),0) FROM model_assets").fetchone()
            if usage[0] >= MAX_LIBRARY_ASSETS or usage[1] >= MAX_LIBRARY_BYTES:
                raise HTTPException(409, "Достигнут лимит библиотеки; обратитесь к оператору сервера")
            fd, temporary = tempfile.mkstemp(prefix=".upload-", suffix=".part", dir=self.root)
            temp_path, final_path, committed = Path(temporary), None, False
            stream, digest, size = os.fdopen(fd, "wb"), hashlib.sha256(), 0
            try:
                try:
                    async with asyncio.timeout(300):
                        async for chunk in request.stream():
                            size += len(chunk)
                            if size > MAX_MODEL_BYTES:
                                raise HTTPException(413, "Модель превышает 50 МБ")
                            if usage[1] + size > MAX_LIBRARY_BYTES:
                                raise HTTPException(409, "Достигнут лимит размера библиотеки")
                            await _disk(_write_chunk, stream, digest, chunk)
                except TimeoutError:
                    raise HTTPException(408, "Истекло время загрузки модели") from None
                await _disk(_flush_file, stream)
                stream.close()
                try:
                    await _disk(validate_glb_file, temp_path, size)
                except (ValueError, struct.error) as error:
                    raise HTTPException(422, str(error)) from None
                asset_id = uuid.uuid4().hex
                final_path = self._file(asset_id)
                await _disk(os.replace, temp_path, final_path)
                timestamp = self.now()
                with self.store.transaction() as db:
                    # Streaming, validation and the file move all yield. A
                    # second administrator may have changed the library since
                    # the initial check; reject rather than advance an old
                    # preparation draft to a fresh revision implicitly.
                    self._check_version(expected_version)
                    db.execute("INSERT INTO model_assets VALUES(?,?,?,?,?,?,1,?,?)",
                               (asset_id, digest.hexdigest(), name, role, size,
                                encode(ModelConfiguration().model_dump(mode="json", exclude_none=True)), timestamp, timestamp))
                    self._bump(db)
                committed = True
                return {"asset": self._view(self._asset(asset_id)), "version": self._state()["version"]}
            except BaseException:
                if final_path is not None and not committed:
                    final_path.unlink(missing_ok=True)
                raise
            finally:
                stream.close()
                temp_path.unlink(missing_ok=True)

    def update(self, asset_id, update: AssetUpdate):
        self._check_version(update.expectedVersion)
        row = self._asset(asset_id)
        values = {"name": row["name"], "role": row["role"], "enabled": bool(row["enabled"]), "config": decode(row["config"])}
        values.update(update.model_dump(mode="json", exclude_none=True, exclude={"expectedVersion", "config"}))
        if update.config is not None:
            changes = update.config.model_dump(mode="json", exclude_none=True, exclude_unset=True)
            values["config"] = ModelConfiguration.model_validate({**values["config"], **changes}).model_dump(mode="json", exclude_none=True)
        profile = decode(self._state()["profile"])
        for role in ROLES:
            if profile[f"{role}Id"] == asset_id and (not values["enabled"] or values["role"] != role):
                profile[f"{role}Id"] = None
        with self.store.transaction() as db:
            self._check_version(update.expectedVersion)
            db.execute("UPDATE model_assets SET name=?,role=?,enabled=?,config=?,updated_at=? WHERE id=?",
                       (values["name"], values["role"], int(values["enabled"]), encode(values["config"]), self.now(), asset_id))
            self._bump(db, profile=profile)
        return {"asset": self._view(self._asset(asset_id)), "version": self._state()["version"]}

    def publish(self, update: ProfileUpdate):
        self._check_version(update.expectedVersion)
        profile = {"tableId": update.tableId, "environmentId": update.environmentId}
        selected = {value for value in profile.values() if value is not None}
        if set(update.configs) - selected:
            raise HTTPException(422, "Конфигурации должны относиться только к выбранным моделям")
        if set(update.names) - selected:
            raise HTTPException(422, "Названия должны относиться только к выбранным моделям")
        for role in ROLES:
            asset_id = profile[f"{role}Id"]
            if asset_id is not None and self._asset(asset_id, enabled_only=True)["role"] != role:
                raise HTTPException(422, "Роль выбранной модели не совпадает с ролью слота")
        with self.store.transaction() as db:
            self._check_version(update.expectedVersion)
            for asset_id, config in update.configs.items():
                db.execute("UPDATE model_assets SET config=?,updated_at=? WHERE id=?",
                           (encode(config.model_dump(mode="json", exclude_none=True)), self.now(), asset_id))
            for asset_id, name in update.names.items():
                db.execute("UPDATE model_assets SET name=?,updated_at=? WHERE id=?",
                           (name, self.now(), asset_id))
            self._bump(db, profile=profile)
        return self.snapshot()


def _write_chunk(stream, digest, chunk):
    stream.write(chunk)
    digest.update(chunk)


def _flush_file(stream):
    stream.flush()
    os.fsync(stream.fileno())


def asset_router() -> APIRouter:
    router = APIRouter()

    def library(request):
        current = getattr(request.app.state, "asset_library", None)
        if current is None:
            raise HTTPException(503, "Библиотека моделей ещё не готова")
        return current

    @router.get("/api/assets/admin/session")
    async def admin_session(request: Request):
        current = library(request)
        session = current.admin_session(request, required=False)
        return {"authenticated": session is not None, "configured": current.configured,
                **({"username": current.username, "csrfToken": session["csrfToken"], "expiresAt": session["expiresAt"]} if session else {})}

    @router.post("/api/assets/admin/login")
    async def admin_login(request: Request):
        current = library(request)
        current.same_origin(request)
        if not current.configured:
            raise HTTPException(503, "Администратор библиотеки не настроен")
        body = await _json(request, AdminLogin, maximum=4096)
        # Serial verification prevents concurrent failures racing the limiter
        # and launching an unbounded number of expensive scrypt computations.
        async with current.login_lock:
            current.throttle.check(request, body.username)
            valid_user = hmac.compare_digest(body.username.encode("utf-8"), current.username.encode("utf-8"))
            valid_password = await _disk(verify_admin_password, body.password, current.password_hash)
            if not valid_user or not valid_password:
                current.throttle.failed(request, body.username)
                raise HTTPException(401, "Неверный логин или пароль")
            current.throttle.success(request, body.username)
            token, timestamp = secrets.token_urlsafe(32), current.now()
            with current.store.transaction() as db:
                db.execute("DELETE FROM asset_admin_sessions WHERE expires_at<=? OR credential_tag!=?", (timestamp, current.credential_tag))
                db.execute("DELETE FROM asset_admin_sessions WHERE token_hash IN (SELECT token_hash FROM asset_admin_sessions ORDER BY created_at DESC LIMIT -1 OFFSET 31)")
                db.execute("INSERT INTO asset_admin_sessions VALUES(?,?,?,?)", (hashlib.sha256(token.encode("ascii")).hexdigest(), current.credential_tag, timestamp, timestamp + ADMIN_SESSION_SECONDS))
        response = JSONResponse({"authenticated": True, "username": current.username, "csrfToken": current._csrf(token), "expiresAt": _utc(timestamp + ADMIN_SESSION_SECONDS)})
        response.set_cookie(ADMIN_COOKIE, token, max_age=ADMIN_SESSION_SECONDS, path=ADMIN_COOKIE_PATH,
                            httponly=True, secure=request.url.scheme == "https", samesite="strict")
        return response

    @router.post("/api/assets/admin/logout")
    async def admin_logout(request: Request):
        current = library(request)
        session = current.admin_session(request, required=False, mutation=True)
        if session:
            with current.store.transaction() as db:
                db.execute("DELETE FROM asset_admin_sessions WHERE token_hash=?", (session["tokenHash"],))
        response = JSONResponse({"authenticated": False})
        response.delete_cookie(ADMIN_COOKIE, path=ADMIN_COOKIE_PATH, httponly=True,
                               secure=request.url.scheme == "https", samesite="strict")
        return response

    @router.get("/api/assets/library")
    async def list_assets(request: Request, includeDisabled: bool = False):
        current = library(request)
        if includeDisabled:
            current.admin_session(request)
        return current.snapshot(include_disabled=includeDisabled)

    @router.post("/api/assets/models")
    async def upload_asset(request: Request, name: str = "Модель", role: str = "table",
                           expectedVersion: Annotated[int | None, Query(ge=0)] = None):
        return await library(request).upload(request, name=name, role=role, expected_version=expectedVersion)

    @router.patch("/api/assets/models/{asset_id}")
    async def update_asset(asset_id: str, request: Request):
        current = library(request)
        current.admin_session(request, mutation=True)
        return current.update(asset_id, await _json(request, AssetUpdate))

    @router.delete("/api/assets/models/{asset_id}")
    async def disable_asset(asset_id: str, request: Request,
                            expectedVersion: Annotated[int | None, Query(ge=0)] = None):
        current = library(request)
        current.admin_session(request, mutation=True)
        return current.update(asset_id, AssetUpdate(enabled=False, expectedVersion=expectedVersion))

    @router.put("/api/assets/library/profile")
    async def publish_profile(request: Request):
        current = library(request)
        current.admin_session(request, mutation=True)
        return current.publish(await _json(request, ProfileUpdate))

    @router.api_route("/models/library/{asset_id}.glb", methods=["GET", "HEAD"])
    async def model_file(asset_id: str, request: Request):
        current = library(request)
        row, path = current._asset(asset_id, enabled_only=True), current._file(asset_id)
        if not path.is_file():
            raise HTTPException(404, "Файл модели не найден")
        if path.stat().st_size != row["byte_size"]:
            raise HTTPException(503, "Файл модели повреждён; обратитесь к администратору")
        return FileResponse(path, media_type="model/gltf-binary", filename=f"{asset_id}.glb",
                            headers={"Cache-Control": "public, max-age=86400, immutable", "ETag": f'"{row["sha256"]}"'})

    return router
