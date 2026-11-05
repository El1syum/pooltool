"""VK Play boundary tests use a fake GAS transport, never live platform tickets."""

import asyncio
import hashlib
import logging
from uuid import uuid4
from urllib.parse import urlencode

from fastapi import HTTPException
from fastapi.testclient import TestClient
import httpx
import pytest

from online.server.app import create_app
from online.server.tests.test_api import TestPhysics
from online.server.vkplay import (
    MAX_ATTEMPTS, RESPONSE_TTL, TICKET_TTL, VkPlayAuth, VkPlayConfig,
    VkPlayLogin, client_ipv4, signature,
)

SECRET = "unique-test-only-vkplay-secret"
APP_ID = "12345"
IP = "203.0.113.9"


def payload(**changes):
    return {"uid": "1001", "hash": "test-only-opaque-OTP", "requestId": str(uuid4()),
            "clientVersion": "vkplay-test", **changes}


@pytest.fixture
def factory(tmp_path, monkeypatch):
    monkeypatch.setenv("VKPLAY_ENABLED", "true")
    monkeypatch.setenv("VKPLAY_GMRID", APP_ID)
    monkeypatch.setenv("VKPLAY_SECRET", SECRET)
    calls = []

    def build(handler=None, ip=IP):
        def gas(request):
            calls.append(request)
            return handler(request) if handler else httpx.Response(200, json={"status": "ok"})
        application = create_app(database=str(tmp_path / "game.sqlite3"), engine=TestPhysics(),
                                 process_pool=False, background=False,
                                 vkplay_transport=httpx.MockTransport(gas))
        return TestClient(application, client=(ip, 12345))

    return build, calls


def test_config_disabled_by_default_and_guest_unaffected(factory, monkeypatch):
    build, calls = factory
    for enabled, secret in (("false", SECRET), ("true", "")):
        monkeypatch.setenv("VKPLAY_ENABLED", enabled)
        monkeypatch.setenv("VKPLAY_SECRET", secret)
        with build() as client:
            config = client.get("/api/auth/config").json()
            assert config["guestEnabled"] is True
            assert config["vkPlay"]["enabled"] is (enabled == "true")
            assert config["vkPlay"]["configured"] is bool(secret)
            assert SECRET not in repr(config)
            assert "secret" not in repr(config).lower()
            assert client.post("/api/auth/vkplay", json=payload()).status_code == 503
            assert client.post("/api/auth/guest", json={"displayName": "Still guest"}).status_code == 200
    assert calls == []


def test_gas_exchange_uses_fixed_https_signature_and_stable_own_identity(factory, caplog):
    build, calls = factory
    caplog.set_level(logging.DEBUG)
    body = payload()
    with build() as client:
        result = client.post("/api/auth/vkplay", json=body)
        assert result.status_code == 200, result.text
        first = result.json()
        assert len(calls) == 1
        request = calls[0]
        assert request.method == "GET"
        assert request.url.scheme == "https" and request.url.host == "vkplay.ru"
        assert request.url.path == f"/app/{APP_ID}/gas"
        expected = {"uid": body["uid"], "hash": body["hash"], "ip": IP}
        raw = f"appid={APP_ID}hash={body['hash']}ip={IP}uid={body['uid']}{SECRET}"
        assert dict(request.url.params) == {**expected, "sign": hashlib.md5(raw.encode()).hexdigest()}
        assert "appid" not in request.url.params
        assert first["user"]["isVk"] is False
        assert client.get("/api/me", headers={"Authorization": f"Bearer {first['token']}"}).status_code == 200
        duplicate = client.post("/api/auth/vkplay", json=body)
        assert duplicate.json() == first
        assert len(calls) == 1
        assert client.post("/api/auth/vkplay", json={**body, "requestId": str(uuid4())}).status_code == 409
        assert len(calls) == 1
        second = client.post("/api/auth/vkplay", json=payload(hash="another-opaque-ticket")).json()
        assert second["user"]["id"] == first["user"]["id"]
        assert second["token"] != first["token"]
        # Platform token or raw secret never lives in SQLite.
        dump = " ".join(client.app.state.service.store.db.iterdump())
        assert body["hash"] not in dump and SECRET not in dump
    assert body["hash"] not in caplog.text and SECRET not in caplog.text
    assert "sign=" not in caplog.text


def test_optional_launch_signature_all_parameters_match_uid_appid(factory):
    build, calls = factory
    params = {"appid": APP_ID, "uid": "1001", "currency": "RUB", "lang": "ru_RU", "platform": "vkplay"}
    signed = urlencode({**params, "sign": signature(params, SECRET)})
    with build() as client:
        assert client.post("/api/auth/vkplay", json=payload(launchParams="?" + signed)).status_code == 200
        assert len(calls) == 1
        for raw in (signed + "&uid=1001", signed.replace("uid=1001", "uid=2002"),
                    signed.replace(f"appid={APP_ID}", "appid=9"), signed.replace("RUB", "EUR"),
                    "https://example.invalid/?" + signed, signed + "&extra=%XX", signed + "&extra=%FF"):
            response = client.post("/api/auth/vkplay", json=payload(hash=str(uuid4()), launchParams=raw))
            assert response.status_code == 401
        assert len(calls) == 1


@pytest.mark.parametrize("changes", [
    {"uid": 1001}, {"uid": "001"}, {"uid": "0"}, {"uid": "-1"},
    {"uid": "1001x"}, {"uid": "1" * 21}, {"hash": " "}, {"hash": "x\nsecret"},
    {"hash": "x" * 2049}, {"requestId": "bad"}, {"launchParams": "x" * 8193},
    {"unexpected": "sensitive-unknown-value"},
])
def test_invalid_body_does_not_echo_credentials_or_call_gas(factory, changes):
    build, calls = factory
    body = payload(hash="never-echo-this-ticket", **changes) if "hash" not in changes else payload(**changes)
    with build() as client:
        response = client.post("/api/auth/vkplay", json=body)
        assert response.status_code == 422
        assert "never-echo-this-ticket" not in response.text
        assert "sensitive-unknown-value" not in response.text
        assert '"input"' not in response.text
        assert calls == []


@pytest.mark.parametrize("handler,status", [
    (lambda request: httpx.Response(200, json={"status": "error", "errmsg": "sensitive-platform-body"}), 401),
    (lambda request: httpx.Response(200, json={"status": "ok", "uid": "different"}), 401),
    (lambda request: httpx.Response(302, headers={"location": "https://attacker.invalid/"}), 502),
    (lambda request: httpx.Response(500, text="sensitive-platform-body"), 502),
    (lambda request: httpx.Response(200, text="not JSON sensitive-platform-body"), 502),
    (lambda request: httpx.Response(200, content=b"x" * 16385), 502),
])
def test_gas_rejections_do_not_create_account_follow_redirect_retry_or_echo(factory, handler, status):
    build, calls = factory
    body = payload()
    with build(handler) as client:
        for _ in range(2):
            response = client.post("/api/auth/vkplay", json=body)
            assert response.status_code == status
            assert "sensitive-platform-body" not in response.text and body["hash"] not in response.text
        assert len(calls) == 1
        assert client.app.state.service.store.db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0


def test_network_ambiguity_requires_new_ticket_without_repeating_gas(factory):
    build, calls = factory
    def timeout(request):
        raise httpx.ReadTimeout("sensitive exception " + str(request.url), request=request)
    body = payload()
    with build(timeout) as client:
        for _ in range(2):
            response = client.post("/api/auth/vkplay", json=body)
            assert response.status_code == 502
            assert body["hash"] not in response.text and SECRET not in response.text
        assert len(calls) == 1


def test_ip_is_from_asgi_not_raw_forwarded_headers(factory):
    build, calls = factory
    with build() as client:
        assert client.post("/api/auth/vkplay", json=payload(), headers={"X-Forwarded-For": "198.51.100.2"}).status_code == 200
        assert calls[0].url.params["ip"] == IP
    with build(ip="2001:db8::1") as client:
        assert client.post("/api/auth/vkplay", json=payload()).status_code == 422
    assert client_ipv4("::ffff:203.0.113.9") == IP
    assert len(calls) == 1


def test_request_id_conflict_never_reuses_another_identity_response(factory):
    build, calls = factory
    body = payload()
    with build() as client:
        assert client.post("/api/auth/vkplay", json=body).status_code == 200
        assert client.post("/api/auth/vkplay", json={**body, "uid": "2002"}).status_code == 409
        assert client.post("/api/auth/vkplay", json={**body, "uid": "2002", "requestId": str(uuid4())}).status_code == 409
        assert len(calls) == 1


def test_concurrent_duplicates_share_one_gas_call_and_capacity_does_not_evict():
    async def run():
        entered, released = asyncio.Event(), asyncio.Event()
        calls = []
        async def gas(request):
            calls.append(request)
            entered.set()
            await released.wait()
            return httpx.Response(200, json={"status": "ok"})
        clock = [0.0]
        auth = VkPlayAuth(VkPlayConfig(True, APP_ID, SECRET), transport=httpx.MockTransport(gas), now=lambda: clock[0])
        issued = []
        async def authenticate(uid):
            issued.append(uid)
            return {"token": "own-session", "user": {"id": "user-id"}}
        body = VkPlayLogin.model_validate(payload())
        owner = asyncio.create_task(auth.exchange(body, IP, authenticate))
        await entered.wait()
        duplicate = asyncio.create_task(auth.exchange(body, IP, authenticate))
        await asyncio.sleep(0)
        released.set()
        assert await owner == await duplicate
        assert len(calls) == len(issued) == 1
        clock[0] = RESPONSE_TTL + 1
        with pytest.raises(HTTPException) as error:
            await auth.exchange(body, IP, authenticate)
        assert error.value.status_code == 409
        assert len(calls) == 1
        # Unexpired tombstones are not discarded just to admit new traffic.
        entry = auth.attempts[body.request_id]
        for index in range(MAX_ATTEMPTS - 1):
            auth.attempts[f"fixture-{index}"] = entry
        with pytest.raises(HTTPException) as error:
            await auth.exchange(VkPlayLogin.model_validate(payload(hash="new-ticket")), IP, authenticate)
        assert error.value.status_code == 503
        assert len(calls) == 1 and len(auth.attempts) == MAX_ATTEMPTS
        clock[0] = TICKET_TTL + 1
        auth._prune()
        assert not auth.attempts
        await auth.close()
    asyncio.run(run())


def test_configuration_never_reveals_secret_repr_or_invalid_app_id():
    config = VkPlayConfig(True, APP_ID, SECRET)
    assert SECRET not in repr(config)
    assert not VkPlayConfig(True, "../123", SECRET).configured
    assert VkPlayConfig(True, "../123", SECRET).public()["vkPlay"]["appId"] is None
    assert not VkPlayConfig(True, APP_ID, " ").configured
    assert VkPlayConfig(True, "9007199254740991", SECRET).configured
    assert not VkPlayConfig(True, "9007199254740992", SECRET).configured
    assert VkPlayConfig(True, "9007199254740992", SECRET).public()["vkPlay"]["appId"] is None
    assert not VkPlayConfig(True, "99999999999999999999", SECRET).configured
    # UID has no SDK-number conversion; its string identity keeps all 20 digits.
    assert VkPlayLogin.model_validate(payload(uid="99999999999999999999")).uid == "99999999999999999999"


def test_total_gas_deadline_prevents_slow_response_and_never_retries(monkeypatch):
    monkeypatch.setattr("online.server.vkplay.GAS_TIMEOUT_SECONDS", .01)
    async def run():
        calls = []
        async def gas(request):
            calls.append(request)
            await asyncio.Event().wait()
        auth = VkPlayAuth(VkPlayConfig(True, APP_ID, SECRET), transport=httpx.MockTransport(gas))
        body = VkPlayLogin.model_validate(payload())
        async def forbidden(uid):
            raise AssertionError("Timed-out GAS must not create an account")
        for _ in range(2):
            with pytest.raises(HTTPException) as error:
                await auth.exchange(body, IP, forbidden)
            assert error.value.status_code == 502
        assert len(calls) == 1 and auth.in_flight == 0
        await auth.close()
    asyncio.run(run())
