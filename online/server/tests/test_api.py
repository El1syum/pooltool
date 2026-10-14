"""Transport/state tests use deterministic test physics, never production fallback."""

import base64
import copy
import hashlib
import hmac
import json
import threading
import time
from urllib.parse import urlencode

import pytest
from fastapi.testclient import TestClient

from online.server.app import create_app


class TestPhysics:
    __test__ = False

    def __init__(self):
        self.calls = 0
        self.block = None
        self.started = threading.Event()

    def new_match(self, seed=None):
        return {"snapshot": {"currentPlayer": 0, "ballInHand": False, "callShotRequired": False,
                             "balls": [{"id": "cue", "position": [0.5, 0.5, 0.03], "radius": 0.03, "pocketed": False}],
                             "table": {"width": 1, "length": 2, "pockets": []}}}

    def simulate(self, state, shot, shooter=0):
        self.calls += 1
        self.started.set()
        if self.block:
            self.block.wait(5)
        if shot["V0"] == 0.5:
            raise ValueError("Invalid called ball")
        updated = copy.deepcopy(state)
        updated["snapshot"]["currentPlayer"] = 1 - shooter
        winner = shooter if shot["V0"] == 7 else None
        rules = {"nextPlayer": 1 - shooter, "foul": False, "ballInHand": False, "winner": winner}
        return {"state": updated, "trajectory": {"duration": 0.1, "frames": []}, "events": [], "potted": [],
                "initialState": state["snapshot"], "finalState": updated["snapshot"], "duration": 0.1, "rules": rules}

    def validate_shot(self, state, shot, shooter=0):
        if shot["V0"] == 0.25:
            raise ValueError("Illegal shot for the current rule constraints")

    def place_cue_ball(self, state, x, y, shooter=0):
        if not state["snapshot"]["ballInHand"]:
            raise ValueError("No ball in hand")
        if not 0.03 < x < 0.97 or not 0.03 < y < 1.97:
            raise ValueError("Outside table")
        result = copy.deepcopy(state)
        result["snapshot"]["ballInHand"] = False
        result["snapshot"]["balls"][0]["position"] = [x, y, 0.03]
        return result

    def timeout(self, state, shooter=0):
        result = copy.deepcopy(state)
        result["snapshot"].update(currentPlayer=1 - shooter, ballInHand=True)
        return result


@pytest.fixture
def setup(tmp_path):
    clock = [1_800_000_000.0]
    engine = TestPhysics()
    application = create_app(database=str(tmp_path / "game.db"), engine=engine, process_pool=False, now=lambda: clock[0], background=False)
    with TestClient(application) as client:
        yield client, engine, clock


def login(client, name):
    response = client.post("/api/auth/guest", json={"displayName": name, "clientVersion": "test-1"})
    assert response.status_code == 200, response.text
    data = response.json()
    return {"Authorization": f"Bearer {data['token']}"}, data


def start_room(client, first, second):
    response = client.post("/api/rooms", headers=first, json={"settings": {"turnSeconds": 60}})
    assert response.status_code == 200, response.text
    code = response.json()["room"]["code"]
    assert client.post(f"/api/rooms/{code.lower()}/join", headers=second).status_code == 200
    assert client.post(f"/api/rooms/{code}/ready", headers=first, json={"ready": True}).status_code == 200
    response = client.post(f"/api/rooms/{code}/ready", headers=second, json={"ready": True})
    assert response.status_code == 200, response.text
    return code, response.json()["match"]


def shot(revision=0, command_id="shot-test-01", speed=3):
    return {"commandId": command_id, "expectedRevision": revision, "type": "shot", "payload": {"V0": speed, "phi": 90}}


def receive_type(socket, kind):
    for _ in range(12):
        data = socket.receive_json()
        if data["type"] == kind:
            return data
    raise AssertionError(f"Did not receive {kind}")


def test_room_turn_validation_and_spectators(setup):
    client, engine, _ = setup
    a, _ = login(client, "А")
    b, _ = login(client, "Б")
    spectator, _ = login(client, "Зритель")
    code, match = start_room(client, a, b)
    endpoint = f"/api/matches/{match['id']}/commands"
    assert client.post(endpoint, headers=b, json=shot()).status_code == 403
    assert client.post(f"/api/rooms/{code}/spectate", headers=spectator).status_code == 200
    assert client.get(f"/api/matches/{match['id']}", headers=spectator).status_code == 200
    assert client.post(endpoint, headers=spectator, json=shot()).status_code == 403
    assert client.post(endpoint, headers=a, json={**shot(), "payload": {"V0": 3, "phi": 90, "positions": []}}).status_code == 422
    assert engine.calls == 0
    result = client.post(endpoint, headers=a, json=shot())
    assert result.status_code == 200, result.text
    assert result.json()["match"]["currentPlayer"] == 1
    assert "state" not in result.json()["result"]
    assert isinstance(result.json()["result"]["playbackStartAt"], int)


def test_idempotency_revision_and_playback_lock(setup):
    client, engine, clock = setup
    a, _ = login(client, "А")
    b, _ = login(client, "Б")
    _, match = start_room(client, a, b)
    endpoint = f"/api/matches/{match['id']}/commands"
    result = client.post(endpoint, headers=a, json=shot()).json()
    repeated = client.post(endpoint, headers=a, json=shot()).json()
    assert repeated["duplicate"] is True
    assert repeated["result"] == result["result"]
    assert engine.calls == 1
    changed = client.post(endpoint, headers=a, json=shot(speed=4))
    assert changed.status_code == 409
    stale = client.post(endpoint, headers=b, json=shot(command_id="shot-test-02"))
    assert stale.status_code == 409
    assert stale.json()["detail"]["match"]["revision"] == 2
    blocked = client.post(endpoint, headers=b, json=shot(2, "shot-test-03"))
    assert blocked.status_code == 409
    clock[0] += 1
    assert client.post(endpoint, headers=b, json=shot(2, "shot-test-03")).status_code == 200


def test_pending_duplicate_and_forfeit_cannot_be_overwritten(setup):
    client, engine, _ = setup
    a, _ = login(client, "А")
    b, data_b = login(client, "Б")
    _, match = start_room(client, a, b)
    endpoint = f"/api/matches/{match['id']}/commands"
    engine.block = threading.Event()
    results = []
    worker = threading.Thread(target=lambda: results.append(client.post(endpoint, headers=a, json=shot())))
    worker.start()
    assert engine.started.wait(3)
    duplicate = client.post(endpoint, headers=a, json=shot())
    assert duplicate.status_code == 200, duplicate.text
    assert duplicate.json()["pending"] is True
    surrender = client.post(endpoint, headers=a, json={"commandId": "surrender-01", "expectedRevision": 1, "type": "surrender"})
    assert surrender.status_code == 200, surrender.text
    engine.block.set()
    worker.join(5)
    assert not worker.is_alive()
    finished = client.get(f"/api/matches/{match['id']}", headers=b).json()["match"]
    assert finished["status"] == "finished"
    assert finished["winnerId"] == data_b["user"]["id"]
    assert finished["reason"] == "surrender"
    assert client.get("/api/me", headers=b).json()["user"]["wins"] == 1


def test_physics_failure_restores_turn_without_fabricated_result(setup):
    client, engine, clock = setup
    a, _ = login(client, "А")
    b, _ = login(client, "Б")
    _, match = start_room(client, a, b)
    endpoint = f"/api/matches/{match['id']}/commands"
    clock[0] += 40
    assert client.post(endpoint, headers=a, json=shot(speed=0.5)).status_code == 422
    restored = client.get(f"/api/matches/{match['id']}", headers=a).json()["match"]
    assert restored["status"] == "active"
    assert restored["currentPlayer"] == 0
    assert restored["lastShot"] is None
    assert restored["turnRemainingSeconds"] == 20
    assert client.post(endpoint, headers=a, json=shot(speed=0.5)).status_code == 422
    assert engine.calls == 1


def test_illegal_shot_never_extends_deadline_or_mutates_revision(setup):
    client, engine, clock = setup
    a, _ = login(client, "А")
    b, _ = login(client, "Б")
    _, match = start_room(client, a, b)
    endpoint = f"/api/matches/{match['id']}/commands"
    clock[0] += 40
    for counter in range(3):
        rejected = client.post(endpoint, headers=a, json=shot(command_id=f"invalid-shot-{counter}", speed=0.25))
        assert rejected.status_code == 422
    current = client.get(f"/api/matches/{match['id']}", headers=a).json()["match"]
    assert current["deadline"] == match["deadline"]
    assert current["revision"] == 0
    assert current["turnRemainingSeconds"] == 20
    assert engine.calls == 0


def test_turn_timeout_and_legal_placement(setup):
    client, _, clock = setup
    a, _ = login(client, "А")
    b, _ = login(client, "Б")
    _, match = start_room(client, a, b)
    clock[0] += 61
    client.portal.call(client.app.state.service.tick)
    timed_out = client.get(f"/api/matches/{match['id']}", headers=b).json()["match"]
    assert timed_out["currentPlayer"] == 1
    assert timed_out["snapshot"]["ballInHand"] is True
    endpoint = f"/api/matches/{match['id']}/commands"
    bad = {"commandId": "placement-bad", "expectedRevision": 1, "type": "placeCueBall", "payload": {"x": 10, "y": 1}}
    assert client.post(endpoint, headers=b, json=bad).status_code == 422
    good = {"commandId": "placement-good", "expectedRevision": 1, "type": "placeCueBall", "payload": {"x": 0.4, "y": 1}}
    assert client.post(endpoint, headers=b, json=good).status_code == 200


def test_ranked_window_elo_history_and_no_repeat_rating(setup):
    client, _, clock = setup
    a, _ = login(client, "А")
    b, data_b = login(client, "Б")
    service = client.app.state.service
    service.store.db.execute("UPDATE users SET elo=1400 WHERE id=?", (data_b["user"]["id"],))
    service.store.db.commit()
    assert client.post("/api/matchmaking", headers=a, json={"mode": "ranked"}).json()["queued"]
    assert client.post("/api/matchmaking", headers=b, json={"mode": "ranked"}).json()["queued"]
    clock[0] += 31
    client.portal.call(service.tick)
    state = client.get("/api/matchmaking", headers=a).json()
    assert not state["queued"]
    match_id = state["matchId"]
    surrender = {"commandId": "ranked-surrender", "expectedRevision": 0, "type": "surrender"}
    result = client.post(f"/api/matches/{match_id}/commands", headers=a, json=surrender)
    assert result.status_code == 200, result.text
    assert client.get("/api/me", headers=a).json()["user"]["elo"] < 1000
    rating = client.get("/api/me", headers=b).json()["user"]["elo"]
    assert rating > 1400
    assert client.post(f"/api/matches/{match_id}/commands", headers=a, json=surrender).json()["duplicate"]
    assert client.get("/api/me", headers=b).json()["user"]["elo"] == rating
    history = client.get("/api/me/history", headers=b).json()["matches"]
    assert len(history) == 1
    assert history[0]["ratings"][1]["after"] == rating
    assert "snapshot" not in history[0]


def test_websocket_auth_broadcast_and_reconnect(setup):
    client, _, _ = setup
    a, data_a = login(client, "А")
    b, data_b = login(client, "Б")
    with client.websocket_connect("/ws") as socket_a, client.websocket_connect("/ws") as socket_b:
        socket_a.send_json({"type": "auth", "token": data_a["token"]})
        assert receive_type(socket_a, "authenticated")["user"]["id"] == data_a["user"]["id"]
        receive_type(socket_a, "restored")
        socket_b.send_json({"type": "auth", "token": data_b["token"]})
        receive_type(socket_b, "authenticated")
        receive_type(socket_b, "restored")
        code, match = start_room(client, a, b)
        assert receive_type(socket_a, "match")["match"]["id"] == match["id"]
        assert receive_type(socket_b, "match")["match"]["id"] == match["id"]
        socket_a.send_json({"type": "ping", "clientTime": 123})
        assert receive_type(socket_a, "pong")["clientTime"] == 123
    with client.websocket_connect("/ws") as reconnected:
        reconnected.send_json({"type": "auth", "token": data_a["token"]})
        restored = receive_type(reconnected, "restored")
        assert restored["room"]["code"] == code
        assert restored["match"]["revision"] == 0
        assert data_a["user"]["id"] not in client.app.state.service._match(match["id"])[0]["disconnected"]


def test_restart_sessions_state_disconnect_grace_and_history(tmp_path):
    database = str(tmp_path / "durable.db")
    clock = [1_800_000_000.0]
    with TestClient(create_app(database=database, engine=TestPhysics(), process_pool=False, now=lambda: clock[0], background=False)) as client:
        a, data_a = login(client, "А")
        b, data_b = login(client, "Б")
        _, match = start_room(client, a, b)
    clock[0] += 10
    with TestClient(create_app(database=database, engine=TestPhysics(), process_pool=False, now=lambda: clock[0], background=False)) as client:
        assert client.get("/api/me", headers=a).json()["user"]["id"] == data_a["user"]["id"]
        restored = client.get("/api/me/current", headers=b).json()["match"]
        assert restored["id"] == match["id"]
        with client.websocket_connect("/ws") as connected:
            connected.send_json({"type": "auth", "token": data_b["token"]})
            receive_type(connected, "restored")
            clock[0] += 31
            client.portal.call(client.app.state.service.tick)
            finished = client.get(f"/api/matches/{match['id']}", headers=b).json()["match"]
            assert finished["winnerId"] == data_b["user"]["id"]
            assert finished["reason"] == "disconnect"
            client.portal.call(client.app.state.service.tick)
            assert client.get("/api/me", headers=b).json()["user"]["wins"] == 1


def test_profile_settings_and_client_telemetry_dedupe_security(setup):
    client, _, _ = setup
    a, data_a = login(client, "А")
    assert client.patch("/api/me", headers=a, json={"displayName": "Новое имя"}).json()["user"]["displayName"] == "Новое имя"
    assert client.put("/api/me/settings", headers=a, json={"settings": {"sound": False, "keys": {"shoot": "Space"}}}).status_code == 200
    assert client.get("/api/me/settings", headers=a).json()["settings"]["sound"] is False
    event = {"id": "client-unique-id", "type": "clientPerformance", "timestamp": "2026-10-14T10:00:00Z",
             "data": {"fps": 60, "drawCalls": 10, "triangles": 100}}
    result = client.post("/api/telemetry/events", headers=a, json={"events": [event]}).json()
    assert result["accepted"] == 1
    repeated = client.post("/api/telemetry/events", headers=a, json={"events": [event]}).json()
    assert repeated["duplicates"] == 1
    assert repeated["acceptedIds"] == [event["id"]]
    assert client.post("/api/telemetry/events", headers=a, json={"events": [{**event, "data": {"token": data_a["token"]}}]}).status_code == 422
    sensitive = {"id": "client-sensitive", "type": "clientError", "data": {"message": "Authorization: Bearer " + data_a["token"]}}
    assert client.post("/api/telemetry/events", headers=a, json={"events": [sensitive]}).status_code == 200
    dump = " ".join(row["payload"] for row in client.app.state.service.store.db.execute("SELECT payload FROM telemetry"))
    assert data_a["token"] not in dump
    sessions = list(client.app.state.service.store.db.execute("SELECT token_hash FROM sessions"))
    assert sessions[0]["token_hash"] != data_a["token"]
    assert client.get("/api/me", headers={"Authorization": "Bearer invalid"}).status_code == 401


def test_vk_strict_signature_and_stable_identity(setup, monkeypatch):
    client, _, clock = setup
    monkeypatch.setenv("VK_APP_ID", "123")
    monkeypatch.setenv("VK_APP_SECRET", "server-secret")
    params = {"vk_app_id": "123", "vk_user_id": "42", "vk_ts": str(int(clock[0]))}
    query = urlencode(sorted(params.items()))
    sign = base64.urlsafe_b64encode(hmac.new(b"server-secret", query.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    payload = {"launchParams": query + "&sign=" + sign}
    first = client.post("/api/auth/vk", json=payload)
    assert first.status_code == 200, first.text
    second = client.post("/api/auth/vk", json=payload)
    assert second.json()["user"]["id"] == first.json()["user"]["id"]
    assert second.json()["token"] != first.json()["token"]
    assert client.post("/api/auth/vk", json={"launchParams": query.replace("user_id=42", "user_id=43") + "&sign=" + sign}).status_code == 401
    assert client.post("/api/auth/vk", json={"launchParams": payload["launchParams"] + "&vk_app_id=123"}).status_code == 401
    clock[0] += 86401
    assert client.post("/api/auth/vk", json=payload).status_code == 401


def test_unconfigured_vk_fails_explicitly(setup, monkeypatch):
    client, _, _ = setup
    monkeypatch.delenv("VK_APP_ID", raising=False)
    monkeypatch.delenv("VK_APP_SECRET", raising=False)
    assert client.post("/api/auth/vk", json={"launchParams": "sign=whatever"}).status_code == 503


def test_real_engine_initialization_failure_is_not_replaced_by_mock(tmp_path, monkeypatch):
    import sys
    from types import SimpleNamespace
    class BrokenEngine:
        def __init__(self):
            raise RuntimeError("Missing native physics dependency")
    monkeypatch.setitem(sys.modules, "online.server.physics", SimpleNamespace(PhysicsEngine=BrokenEngine))
    with TestClient(create_app(database=str(tmp_path / "unavailable.db"), background=False)) as client:
        response = client.get("/ready")
        assert response.status_code == 503
        assert response.json()["physics"] == "unavailable"
        assert client.post("/api/auth/guest", json={}).status_code == 503


def test_parallel_client_telemetry_writes_have_consistent_dedupe(setup):
    from concurrent.futures import ThreadPoolExecutor
    client, _, _ = setup
    a, _ = login(client, "А")
    b, _ = login(client, "Б")
    def write(index):
        identity = a if index % 2 else b
        event = {"id": f"parallel-{index}", "type": "clientPerformance", "data": {"fps": 60}}
        response = client.post("/api/telemetry/events", headers=identity, json={"events": [event]})
        assert response.status_code == 200, response.text
        return response.json()["accepted"]
    with ThreadPoolExecutor(max_workers=4) as workers:
        assert sum(workers.map(write, range(20))) == 20
    with ThreadPoolExecutor(max_workers=4) as workers:
        assert sum(workers.map(write, range(20))) == 0


def test_pending_command_is_recovered_after_server_restart(tmp_path):
    from online.server.storage import encode
    database = str(tmp_path / "pending.db")
    clock = [1_800_000_000.0]
    command = shot(command_id="durable-pending-shot")
    command["payload"].update(theta=0.0, a=0.0, b=0.0)
    with TestClient(create_app(database=database, engine=TestPhysics(), process_pool=False, now=lambda: clock[0], background=False)) as client:
        a, data_a = login(client, "А")
        b, _ = login(client, "Б")
        _, match = start_room(client, a, b)
        service = client.app.state.service
        saved, physics, _ = service._match(match["id"])
        saved["status"] = "calculating"
        saved["revision"] = 1
        saved["deadline"] = None
        pending = {"command": command, "userId": data_a["user"]["id"], "shooter": 0,
                   "startedAt": clock[0], "session": service.session(data_a["token"])}
        with service.store.transaction() as db:
            db.execute("INSERT INTO commands VALUES(?,?,?,?,?,?,?)", (match["id"], command["commandId"], data_a["user"]["id"], encode(command), "pending", None, clock[0]))
            service._save_match(db, saved, physics, pending)
    recovery_engine = TestPhysics()
    with TestClient(create_app(database=database, engine=recovery_engine, process_pool=False, now=lambda: clock[0], background=False)) as client:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            recovered = client.get(f"/api/matches/{match['id']}", headers=a).json()["match"]
            if recovered["status"] != "calculating":
                break
            time.sleep(0.01)
        assert recovered["status"] == "active"
        assert recovered["revision"] == 2
        assert recovered["lastShot"]["shotId"] == command["commandId"]
        assert recovery_engine.calls == 1
        duplicate = client.post(f"/api/matches/{match['id']}/commands", headers=a, json=command)
        assert duplicate.status_code == 200, duplicate.text
        assert duplicate.json()["duplicate"] is True
        assert recovery_engine.calls == 1


def time_of(value):
    from datetime import datetime
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def test_opponent_sees_disconnect_with_forfeit_time_and_its_clearing(setup):
    client, _, clock = setup
    a, data_a = login(client, "А")
    b, data_b = login(client, "Б")
    with client.websocket_connect("/ws") as socket_b:
        socket_b.send_json({"type": "auth", "token": data_b["token"]})
        receive_type(socket_b, "restored")
        _, match = start_room(client, a, b)
        receive_type(socket_b, "match")
        # Starlette's test socket cancels the server handler on close, so the
        # socket-close path is invoked directly, as uvicorn does after a drop.
        service = client.app.state.service
        client.portal.call(service.disconnect, data_a["user"]["id"], service.session(data_a["token"]))
        # The remaining player is told immediately, not only when the forfeit happens.
        notice = receive_type(socket_b, "match")["match"]
        grace = client.app.state.service.grace
        forfeit_at = notice["disconnectedPlayers"][data_a["user"]["id"]]
        assert abs(time_of(forfeit_at) - (clock[0] + grace)) < 1
        assert "disconnected" not in notice
        with client.websocket_connect("/ws") as socket_a:
            socket_a.send_json({"type": "auth", "token": data_a["token"]})
            receive_type(socket_a, "restored")
            assert receive_type(socket_b, "match")["match"]["disconnectedPlayers"] == {}


def test_finished_playback_is_not_rebroadcast_and_history_has_elo_and_opponent(setup):
    client, _, clock = setup
    a, data_a = login(client, "А")
    b, _ = login(client, "Б")
    _, match = start_room(client, a, b)
    endpoint = f"/api/matches/{match['id']}/commands"
    assert client.post(endpoint, headers=a, json=shot()).status_code == 200
    during = client.get(f"/api/matches/{match['id']}", headers=b).json()["match"]
    assert "trajectory" in during["lastShot"]["result"]
    clock[0] += 1
    after = client.get(f"/api/matches/{match['id']}", headers=b).json()["match"]
    assert "trajectory" not in after["lastShot"]["result"]
    surrender = {"commandId": "casual-surrender", "expectedRevision": after["revision"], "type": "surrender"}
    assert client.post(endpoint, headers=b, json=surrender).status_code == 200
    item = client.get("/api/me/history", headers=a).json()["matches"][0]
    assert item["opponentName"] == "Б"
    assert item["eloDelta"] is None  # Casual matches do not change rating.


def test_ranked_history_reports_own_elo_delta(setup):
    client, _, clock = setup
    a, data_a = login(client, "А")
    b, _ = login(client, "Б")
    client.post("/api/matchmaking", headers=a, json={"mode": "ranked"})
    client.post("/api/matchmaking", headers=b, json={"mode": "ranked"})
    match_id = client.get("/api/matchmaking", headers=a).json()["matchId"]
    client.post(f"/api/matches/{match_id}/commands", headers=b, json={"commandId": "ranked-delta", "expectedRevision": 0, "type": "surrender"})
    item = client.get("/api/me/history", headers=a).json()["matches"][0]
    assert item["eloDelta"] == client.get("/api/me", headers=a).json()["user"]["elo"] - 1000 > 0


def test_finished_rooms_are_closed_after_ttl_and_players_become_free(setup):
    client, _, clock = setup
    a, _ = login(client, "А")
    b, _ = login(client, "Б")
    code, match = start_room(client, a, b)
    client.post(f"/api/matches/{match['id']}/commands", headers=a, json={"commandId": "ttl-surrender", "expectedRevision": 0, "type": "surrender"})
    assert client.get("/api/me/current", headers=a).json()["room"]["status"] == "finished"
    clock[0] += client.app.state.service.room_ttl + 1
    client.portal.call(client.app.state.service.tick)
    assert client.get("/api/me/current", headers=a).json()["room"] is None
    assert client.post("/api/rooms", headers=a, json={}).status_code == 200
    assert len(client.get("/api/me/history", headers=a).json()["matches"]) == 1
