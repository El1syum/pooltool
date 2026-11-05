"""Optional VK Play browser authentication; guest/Mini Apps auth stays separate.

GAS is a fixed HTTPS service. Its OTP is verified once, then exchanged for our
ordinary opaque game session. No platform credential is persisted or logged.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import hashlib
import hmac
import ipaddress
import json
import os
import re
import time
from typing import Awaitable, Callable
from urllib.parse import parse_qsl
from uuid import UUID

import httpx
from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

ID = re.compile(r"[1-9][0-9]{0,19}\Z")
MAX_ATTEMPTS = 1024
MAX_IN_FLIGHT = 8
TICKET_TTL = 300
RESPONSE_TTL = 60
GAS_TIMEOUT_SECONDS = 8
MAX_SAFE_JS_INTEGER = 9007199254740991


def valid_app_id(value: str) -> bool:
    # The browser SDK accepts appid as a JavaScript number. This is a transport
    # precision bound, not an invented VK Play project-ID length requirement.
    return bool(ID.fullmatch(value) and int(value) <= MAX_SAFE_JS_INTEGER)


def signature(parameters: dict[str, str], secret: str) -> str:
    """VK Play's documented algorithm, not VK Mini Apps HMAC-SHA256."""
    value = "".join(f"{key}={parameters[key]}" for key in sorted(parameters)) + secret
    return hashlib.md5(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class VkPlayConfig:
    enabled: bool
    app_id: str
    secret: str = field(repr=False)

    @classmethod
    def from_env(cls):
        return cls(os.getenv("VKPLAY_ENABLED", "").lower() in {"1", "true", "yes", "on"},
                   os.getenv("VKPLAY_GMRID", ""), os.getenv("VKPLAY_SECRET", ""))

    @property
    def configured(self):
        return bool(valid_app_id(self.app_id) and self.secret.strip() and 1 <= len(self.secret) <= 1024
                    and not any(ord(char) < 32 or ord(char) == 127 for char in self.secret))

    def public(self):
        return {"guestEnabled": True, "vkPlay": {"enabled": self.enabled,
                "configured": self.configured, "appId": self.app_id if valid_app_id(self.app_id) else None}}


class VkPlayLogin(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    uid: str = Field(min_length=1, max_length=20)
    otp_hash: str = Field(alias="hash", min_length=1, max_length=2048, repr=False)
    request_id: str = Field(alias="requestId", min_length=36, max_length=36)
    launch_params: str | None = Field(alias="launchParams", default=None, max_length=8192, repr=False)
    client_version: str = Field(alias="clientVersion", default="unknown", max_length=64)

    @field_validator("uid")
    @classmethod
    def uid_format(cls, value):
        if not ID.fullmatch(value):
            raise ValueError("Некорректный идентификатор VK Play")
        return value

    @field_validator("otp_hash")
    @classmethod
    def ticket_format(cls, value):
        if any(ord(char) < 33 or ord(char) > 126 for char in value):
            raise ValueError("Некорректный токен VK Play")
        return value

    @field_validator("request_id")
    @classmethod
    def request_format(cls, value):
        try:
            parsed = UUID(value)
        except ValueError:
            raise ValueError("Некорректный идентификатор запроса") from None
        if str(parsed) != value:
            raise ValueError("Некорректный идентификатор запроса")
        return value


async def parse_login(request: Request) -> VkPlayLogin:
    if request.headers.get("content-type", "").split(";", 1)[0].lower() != "application/json":
        raise HTTPException(415, "Требуется JSON")
    raw = bytearray()
    try:
        async with asyncio.timeout(15):
            async for chunk in request.stream():
                if len(raw) + len(chunk) > 16384:
                    raise HTTPException(413, "Слишком большой запрос авторизации")
                raw.extend(chunk)
        data = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        return VkPlayLogin.model_validate(data)
    except ValidationError as error:
        # Default FastAPI/Pydantic errors include `input`, which may be an OTP.
        errors = [{"loc": item["loc"], "msg": item["msg"], "type": item["type"]}
                  for item in error.errors(include_input=False, include_url=False)]
        raise HTTPException(422, errors) from None
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise HTTPException(422, "Некорректный JSON авторизации") from None
    except TimeoutError:
        raise HTTPException(408, "Истекло время передачи авторизации") from None


def client_ipv4(value: str | None) -> str:
    try:
        address = ipaddress.ip_address(value or "")
    except ValueError:
        raise HTTPException(422, "Не удалось определить IPv4 клиента для VK Play") from None
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    if not isinstance(address, ipaddress.IPv4Address):
        raise HTTPException(422, "GAS VK Play требует IPv4 клиента; IPv6 пока не поддерживается")
    return str(address)


def verify_launch(raw: str | None, config: VkPlayConfig, uid: str):
    if raw is None:
        return
    if "://" in raw or re.search(r"%(?![0-9a-fA-F]{2})", raw):
        raise HTTPException(401, "Некорректные параметры запуска VK Play")
    try:
        pairs = parse_qsl(raw.lstrip("?"), keep_blank_values=True, max_num_fields=64,
                          encoding="utf-8", errors="strict")
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(401, "Некорректные параметры запуска VK Play") from None
    params = dict(pairs)
    if len(params) != len(pairs):
        raise HTTPException(401, "Повторяющиеся параметры запуска VK Play")
    signed = params.pop("sign", "")
    if params.get("appid") != config.app_id or params.get("uid") != uid:
        raise HTTPException(401, "Пользователь или приложение VK Play не совпадает")
    expected = signature(params, config.secret)
    if not re.fullmatch(r"[0-9a-fA-F]{32}", signed) or not hmac.compare_digest(expected, signed.lower()):
        raise HTTPException(401, "Неверная подпись запуска VK Play")


class _GasTransport(httpx.AsyncBaseTransport):
    """Keep OTP/sign out of httpx's INFO request URL logging.

    The client-visible request has a query-free URL. Only the underlying network
    transport receives the real fixed-service query; no second httpx client logs
    it. httpcore's trace messages log connection/method metadata, not URL query.
    """
    def __init__(self, transport=None):
        self.transport = transport or httpx.AsyncHTTPTransport(retries=0, trust_env=False)

    async def handle_async_request(self, request):
        parameters = request.extensions.pop("vkplay_gas_parameters")
        outbound = httpx.Request(request.method, request.url.copy_merge_params(parameters),
                                 headers=request.headers, extensions=request.extensions)
        response = await self.transport.handle_async_request(outbound)
        response.request = request
        return response

    async def aclose(self):
        await self.transport.aclose()


@dataclass
class _Attempt:
    fingerprint: str
    ticket_digest: str
    created: float
    future: asyncio.Future | None
    response: dict | None = field(default=None, repr=False)
    error_status: int = 409
    error_code: str = "vkplay_new_ticket_required"


class VkPlayAuth:
    def __init__(self, config: VkPlayConfig, *, transport=None, now=time.monotonic):
        self.config = config
        self.now = now
        self.attempts: dict[str, _Attempt] = {}
        self.tickets: dict[str, str] = {}
        self.lock = asyncio.Lock()
        self.in_flight = 0
        self.client = httpx.AsyncClient(transport=_GasTransport(transport),
                                      timeout=httpx.Timeout(8), follow_redirects=False,
                                      trust_env=False)

    async def close(self):
        await self.client.aclose()
        self.attempts.clear()
        self.tickets.clear()

    def _prune(self):
        now = self.now()
        for key, attempt in tuple(self.attempts.items()):
            if attempt.future is None and now - attempt.created >= TICKET_TTL:
                del self.attempts[key]
                self.tickets.pop(attempt.ticket_digest, None)
            elif now - attempt.created >= RESPONSE_TTL:
                attempt.response = None

    @staticmethod
    def _error(status=401, code="vkplay_new_ticket_required"):
        return HTTPException(status, {"message": "Не удалось подтвердить вход VK Play. Повторите вход для получения нового токена.", "code": code})

    async def exchange(self, body: VkPlayLogin, ip: str | None,
                       authenticate: Callable[[str], Awaitable[dict]]):
        if not self.config.enabled or not self.config.configured:
            raise HTTPException(503, {"message": "Авторизация VK Play пока не настроена", "code": "vkplay_not_configured"})
        ip = client_ipv4(ip)
        verify_launch(body.launch_params, self.config, body.uid)
        fingerprint = hashlib.sha256(json.dumps([self.config.app_id, body.uid, body.otp_hash,
                                                  ip, body.launch_params, body.client_version]).encode()).hexdigest()
        # GAS tickets are single-use per application, not per claimed UID. A
        # caller changing UID must not cause a second check of the same ticket.
        ticket_digest = hashlib.sha256(f"{self.config.app_id}\0{body.otp_hash}".encode()).hexdigest()
        owner = False
        async with self.lock:
            self._prune()
            attempt = self.attempts.get(body.request_id)
            if attempt is not None:
                if not hmac.compare_digest(attempt.fingerprint, fingerprint):
                    raise self._error(409, "vkplay_request_conflict")
                if attempt.response is not None:
                    return dict(attempt.response)
                if attempt.future is None:
                    raise self._error(attempt.error_status, attempt.error_code)
            else:
                if ticket_digest in self.tickets:
                    raise self._error(409)
                if len(self.attempts) >= MAX_ATTEMPTS or self.in_flight >= MAX_IN_FLIGHT:
                    raise self._error(503, "vkplay_auth_busy")
                attempt = _Attempt(fingerprint, ticket_digest, self.now(), asyncio.get_running_loop().create_future())
                self.attempts[body.request_id] = attempt
                self.tickets[ticket_digest] = body.request_id
                self.in_flight += 1
                owner = True
            pending = attempt.future
        if not owner:
            # Shield the owner's GAS operation if a duplicate HTTP request ends.
            status, value = await asyncio.shield(pending)
            if status != 200:
                raise self._error(status, value)
            return dict(value)
        status, value = 502, "vkplay_new_ticket_required"
        try:
            await self._verify_gas(body.uid, body.otp_hash, ip)
            response = await authenticate(body.uid)
            status, value = 200, response
            return dict(response)
        except HTTPException as failure:
            status = failure.status_code
            raise self._error(status) from None
        except asyncio.CancelledError:
            status = 503
            raise
        except Exception:
            # No exception repr: HTTP errors can contain the full secret URL.
            raise self._error(502) from None
        finally:
            async with self.lock:
                self.in_flight -= 1
                attempt.future = None
                if status == 200:
                    attempt.response = value
                    # Successful retries cache a session for RESPONSE_TTL, while
                    # the consumed-ticket tombstone remains for TICKET_TTL.
                    attempt.created = self.now()
                else:
                    attempt.error_status, attempt.error_code = status, value
                if not pending.done():
                    pending.set_result((status, value))

    async def _verify_gas(self, uid: str, otp_hash: str, ip: str):
        values = {"uid": uid, "hash": otp_hash, "ip": ip}
        values["sign"] = signature({**values, "appid": self.config.app_id}, self.config.secret)
        try:
            async with asyncio.timeout(GAS_TIMEOUT_SECONDS):
                async with self.client.stream("GET", f"https://vkplay.ru/app/{self.config.app_id}/gas",
                                              headers={"Accept-Encoding": "identity"},
                                              extensions={"vkplay_gas_parameters": values}) as response:
                    if response.status_code != 200:
                        raise self._error(502)
                    raw = bytearray()
                    async for chunk in response.aiter_bytes(chunk_size=4096):
                        if len(raw) + len(chunk) > 16384:
                            raise self._error(502)
                        raw.extend(chunk)
                    data = json.loads(raw)
                    if not isinstance(data, dict) or data.get("status") != "ok":
                        raise self._error(401)
                    if "uid" in data and str(data["uid"]) != uid:
                        raise self._error(401)
        except HTTPException:
            raise
        except Exception:
            raise self._error(502) from None
