"""Opt-in smoke probe against a running service; creates disposable guest games.

Run: python -m online.server.tests.live_probe http://127.0.0.1:8790
"""

import asyncio
import json
import sys
import time
import uuid

import httpx
import websockets


async def receive_type(socket, kind, *, match_status=None):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        data = json.loads(await asyncio.wait_for(socket.recv(), timeout=45))
        if data["type"] == kind and (not match_status or data.get("match", {}).get("status") == match_status):
            return data
    raise AssertionError(f"Missing websocket event {kind}")


async def main(base_url):
    # This probe targets the named service directly. Windows registry/system
    # proxies can fabricate transport 502s even with no HTTP_PROXY environment.
    async with httpx.AsyncClient(base_url=base_url, timeout=90, trust_env=False) as client:
        async def request(method, path, actor=None, body=None):
            headers = {"Authorization": "Bearer " + actor["token"]} if actor else {}
            response = await client.request(method, path, headers=headers, json=body)
            assert response.status_code == 200, f"{method} {path}: {response.status_code} {response.text}"
            return response.json()

        a = await request("POST", "/api/auth/guest", body={"displayName": "E2E API A", "clientVersion": "live-probe-1"})
        b = await request("POST", "/api/auth/guest", body={"displayName": "E2E API B", "clientVersion": "live-probe-1"})
        settings = {"graphics": "low", "sound": False, "keys": {"shoot": "Space"}}
        await request("PATCH", "/api/me", a, {"displayName": "E2E API renamed"})
        await request("PUT", "/api/me/settings", a, {"settings": settings})
        assert (await request("GET", "/api/me/settings", a))["settings"] == settings
        assert (await request("POST", "/api/matchmaking", a, {"mode": "ranked"}))["queued"]
        paired = await request("POST", "/api/matchmaking", b, {"mode": "ranked"})
        assert not paired["queued"]
        match_id = paired["matchId"]
        match = (await request("GET", f"/api/matches/{match_id}", a))["match"]
        assert {player["id"] for player in match["players"]} == {a["user"]["id"], b["user"]["id"]}
        surrender = {"commandId": str(uuid.uuid4()), "expectedRevision": match["revision"], "type": "surrender", "payload": {}}
        ended = (await request("POST", f"/api/matches/{match_id}/commands", a, surrender))["match"]
        assert ended["winnerId"] == b["user"]["id"]
        assert (await request("GET", "/api/me", a))["user"]["elo"] == 984
        assert (await request("GET", "/api/me", b))["user"]["elo"] == 1016
        assert (await request("GET", "/api/me/history", a))["matches"][0]["id"] == match_id
        event = {"id": str(uuid.uuid4()), "type": "clientPerformance", "clientVersion": "live-probe-1",
                 "matchId": match_id, "turnId": 1, "data": {"fps": 60, "drawCalls": 32, "triangles": 1000}}
        assert (await request("POST", "/api/telemetry/events", a, {"events": [event]}))["accepted"] == 1
        assert (await request("POST", "/api/telemetry/events", a, {"events": [event]}))["duplicates"] == 1
        exported = await request("GET", f"/api/matches/{match_id}/telemetry", a)
        assert {entry["type"] for entry in exported["events"]} >= {"matchStart", "matchEnd", "clientPerformance"}
        for actor in (a, b):
            await request("POST", f"/api/rooms/{paired['room']['code']}/leave", actor)
        print("PASS real ranked queue, Elo 984/1016, profiles, settings, history, telemetry/export")

        ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://").rstrip("/") + "/ws"
        async with websockets.connect(ws_url, proxy=None, max_size=16 * 1024 * 1024) as socket_a, websockets.connect(ws_url, proxy=None, max_size=16 * 1024 * 1024) as socket_b:
            for socket, actor in ((socket_a, a), (socket_b, b)):
                await socket.send(json.dumps({"type": "auth", "token": actor["token"]}))
                await receive_type(socket, "restored")
            room = (await request("POST", "/api/rooms", a, {"settings": {"turnSeconds": 60}}))["room"]
            await request("POST", f"/api/rooms/{room['code']}/join", b)
            await request("POST", f"/api/rooms/{room['code']}/ready", a, {"ready": True})
            match = (await request("POST", f"/api/rooms/{room['code']}/ready", b, {"ready": True}))["match"]
            await receive_type(socket_a, "match", match_status="active")
            await receive_type(socket_b, "match", match_status="active")
            command = {"commandId": str(uuid.uuid4()), "expectedRevision": 0, "type": "shot", "payload": {"V0": 3, "phi": 90}}
            shot_request = asyncio.create_task(request("POST", f"/api/matches/{match['id']}/commands", a, command))
            calculating = await receive_type(socket_a, "match", match_status="calculating")
            assert calculating["match"]["revision"] == 1
            await socket_a.close()
            async with websockets.connect(ws_url, proxy=None, max_size=16 * 1024 * 1024) as reconnected:
                await reconnected.send(json.dumps({"type": "auth", "token": a["token"]}))
                restored = await receive_type(reconnected, "restored")
                assert restored["match"]["id"] == match["id"]
                result = await shot_request
                current = (await request("GET", f"/api/matches/{match['id']}", a))["match"]
                assert current["revision"] == 2
                assert current["lastShot"]["shotId"] == command["commandId"]
                assert len(current["lastShot"]["result"]["trajectory"]["frames"]) > 2
                duplicate = await request("POST", f"/api/matches/{match['id']}/commands", a, command)
                assert duplicate["duplicate"]
                print("PASS real reconnect after calculating event; restored status=" + restored["match"]["status"] +
                      ", frames=" + str(len(result["result"]["trajectory"]["frames"])) +
                      ", wallDuration=" + str(round(result["result"]["wallDuration"], 3)))
                telemetry = await request("GET", f"/api/matches/{match['id']}/telemetry", a)
                shot_events = [event for event in telemetry["events"] if event["type"] in ("shotStart", "shotResult")]
                assert len(shot_events) == 2
                assert {event["turnId"] for event in shot_events} == {1}
                for actor in (a, b):
                    await request("POST", f"/api/rooms/{room['code']}/leave", actor)
        print("PASS cleanup and stable authoritative shot turn telemetry")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8790"))
