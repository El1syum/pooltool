"""Playback transport stays small without losing authoritative diagnostics."""

import asyncio
import copy
import json

from online.server.app import Hub
from .test_api import login, setup, shot, start_room


def test_playback_projection_keeps_full_events_in_telemetry(setup, monkeypatch):
    client, engine, clock = setup
    original = engine.simulate
    full_event = {"id": "event_1", "type": "ball_ball", "time": 0.04,
                  "ids": ["cue", "1"],
                  "initial": {"cue": {"position": [0.5, 0.5, 0.03], "velocity": [1, 0, 0]}},
                  "final": {"cue": {"position": [0.5, 0.5, 0.03], "velocity": [0, 0, 0]}}}
    produced = []

    def simulate(*args, **kwargs):
        result = original(*args, **kwargs)
        result["events"] = [copy.deepcopy(full_event)]
        produced.append(result)
        return result

    monkeypatch.setattr(engine, "simulate", simulate)
    a, _ = login(client, "А")
    b, _ = login(client, "Б")
    _, match = start_room(client, a, b)
    endpoint = f"/api/matches/{match['id']}/commands"
    response = client.post(endpoint, headers=a, json=shot()).json()
    compact = {key: full_event[key] for key in ("id", "type", "time", "ids")}
    assert response["result"]["events"] == [compact]
    assert produced[0]["events"] == [full_event]
    assert "result" not in response["match"]["lastShot"]
    during = client.get(f"/api/matches/{match['id']}", headers=b).json()["match"]
    assert during["lastShot"]["result"]["events"] == [compact]
    duplicate = client.post(endpoint, headers=a, json=shot()).json()
    assert duplicate["result"] == response["result"]
    exported = client.get(f"/api/matches/{match['id']}/telemetry", headers=a).json()
    result_event = next(event for event in exported["events"] if event["type"] == "shotResult")
    assert result_event["data"]["events"] == [full_event]
    clock[0] += 1
    after = client.get(f"/api/matches/{match['id']}", headers=b).json()["match"]
    assert "trajectory" not in after["lastShot"]["result"]


def test_public_projection_skips_heavy_copies_and_does_not_mutate_legacy_data(setup):
    client, _, clock = setup
    service = client.app.state.service

    class NotForCopy:
        def __deepcopy__(self, memo):
            raise AssertionError("omitted trajectory must not be copied")

    event = {"id": "1", "time": 0, "type": "ball_ball", "ids": ["cue", "1"],
             "initial": NotForCopy(), "final": NotForCopy()}
    raw = {"id": "legacy", "playbackUntil": None, "disconnected": {},
           "lastShot": {"shotId": "s", "result": {"events": [event], "trajectory": NotForCopy()}}}
    projected = service.public_match(raw)
    assert set(projected["lastShot"]["result"]["events"][0]) == {"id", "time", "type", "ids"}
    projected["lastShot"]["result"]["events"][0]["ids"].append("2")
    assert event["ids"] == ["cue", "1"]
    assert "trajectory" in raw["lastShot"]["result"]
    raw["playbackUntil"] = "2099-01-01T00:00:00Z"
    assert "result" not in service.public_match(raw, include_last_result=False)["lastShot"]


def test_hub_serializes_a_broadcast_once_and_keeps_socket_order(monkeypatch):
    import online.server.app as app_module
    calls = []
    original = app_module.encode

    def counting_encode(value):
        calls.append(value)
        return original(value)

    monkeypatch.setattr(app_module, "encode", counting_encode)

    class Socket:
        def __init__(self):
            self.messages = []

        async def send_text(self, text):
            self.messages.append(text)

    async def scenario():
        hub = Hub()
        first, second = Socket(), Socket()
        hub.sockets["a"] = {first}
        hub.sockets["b"] = {second, first}
        for socket in (first, second):
            hub.locks[socket] = asyncio.Lock()
        payload = {"type": "match", "result": {"events": [{"type": "ball_ball"}]}}
        await hub.emit(["a", "b"], payload)
        await hub.send(first, {"type": "pong", "serverTime": 123})
        assert len(calls) == 2  # One shared encoding, one subsequent direct message.
        assert len(first.messages) == 2 and len(second.messages) == 1
        assert first.messages[0] is second.messages[0]
        assert json.loads(first.messages[0]) == payload
        assert json.loads(first.messages[1])["type"] == "pong"

    asyncio.run(scenario())


def test_heavy_diagnostic_serialization_happens_before_playback_scheduling(setup, monkeypatch):
    import online.server.service as service_module
    client, _, clock = setup
    original = service_module.encode
    preparations = []

    def slow_diagnostics(value):
        if isinstance(value, dict) and "simulatedDuration" in value and "events" in value:
            preparations.append(clock[0])
            clock[0] += 0.75  # Explicit fixture: expensive diagnostic serialization.
        return original(value)

    monkeypatch.setattr(service_module, "encode", slow_diagnostics)
    a, _ = login(client, "А")
    b, _ = login(client, "Б")
    _, match = start_room(client, a, b)
    before = clock[0]
    result = client.post(f"/api/matches/{match['id']}/commands", headers=a, json=shot()).json()
    assert preparations == [before]
    assert result["result"]["playbackStartAt"] >= round((before + .75) * 1000)
    assert result["match"]["lastShot"]["startAt"] == result["result"]["playbackStartAt"]
