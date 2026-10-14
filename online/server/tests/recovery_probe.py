"""Opt-in destructive-to-connections recovery probe for the dedicated test service.

Creates disposable guests, makes a real shot, restarts only pooltool-online.service
on the explicitly named host, and verifies durable state through real HTTP/WSS.

Run only after a release is ready:
python -m online.server.tests.recovery_probe http://82.25.61.116:8790 --ssh-host el1s --restart
"""

import argparse
import asyncio
import json
import subprocess
import time
import uuid

import httpx
import websockets

from .live_probe import receive_type


async def main(base_url, ssh_host):
    async with httpx.AsyncClient(base_url=base_url, timeout=90, trust_env=False) as client:
        async def request(method, path, actor=None, body=None):
            headers = {"Authorization": "Bearer " + actor["token"]} if actor else {}
            response = await client.request(method, path, headers=headers, json=body)
            assert response.status_code == 200, f"{method} {path}: {response.status_code} {response.text}"
            return response.json()

        a = await request("POST", "/api/auth/guest", body={"displayName": "Recovery API A", "clientVersion": "recovery-probe-1"})
        b = await request("POST", "/api/auth/guest", body={"displayName": "Recovery API B", "clientVersion": "recovery-probe-1"})
        settings = {"graphics": "low", "sound": False, "keys": {"shoot": "Space", "aim": "Mouse0"}}
        await request("PATCH", "/api/me", a, {"displayName": "Recovery renamed A"})
        await request("PUT", "/api/me/settings", a, {"settings": settings})
        ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://").rstrip("/") + "/ws"
        sockets = []
        try:
            for actor in (a, b):
                socket = await websockets.connect(ws_url, proxy=None, max_size=16 * 1024 * 1024)
                sockets.append(socket)
                await socket.send(json.dumps({"type": "auth", "token": actor["token"]}))
                await receive_type(socket, "restored")
            room = (await request("POST", "/api/rooms", a, {"settings": {"turnSeconds": 180}}))["room"]
            await request("POST", f"/api/rooms/{room['code']}/join", b)
            await request("POST", f"/api/rooms/{room['code']}/ready", a, {"ready": True})
            match = (await request("POST", f"/api/rooms/{room['code']}/ready", b, {"ready": True}))["match"]
            command = {"commandId": str(uuid.uuid4()), "expectedRevision": 0, "type": "shot", "payload": {"V0": 3, "phi": 90}}
            await request("POST", f"/api/matches/{match['id']}/commands", a, command)
            before = (await request("GET", f"/api/matches/{match['id']}", a))["match"]
            assert before["status"] == "active" and before["revision"] == 2
            event = {"id": str(uuid.uuid4()), "type": "clientPerformance", "clientVersion": "recovery-probe-1",
                     "matchId": match["id"], "turnId": 1, "data": {"fps": 60, "count": 1}}
            await request("POST", "/api/telemetry/events", a, {"events": [event]})
            telemetry_before = await request("GET", f"/api/matches/{match['id']}/telemetry", a)
            event_ids = {entry["id"] for entry in telemetry_before["events"]}
            await asyncio.gather(*(socket.close() for socket in sockets))
            sockets.clear()
            started = time.monotonic()
            restart = await asyncio.to_thread(subprocess.run, ["ssh", ssh_host, "sudo", "systemctl", "restart", "pooltool-online.service"],
                                               capture_output=True, text=True, timeout=60, check=False)
            assert restart.returncode == 0, "Dedicated service restart failed"
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                try:
                    ready = await client.get("/ready", timeout=5)
                    if ready.status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(1)
            else:
                raise AssertionError("Dedicated service did not become ready after restart")
            print("PASS dedicated service restart/readiness in " + str(round(time.monotonic() - started, 2)) + "s")
            for actor in (a, b):
                socket = await websockets.connect(ws_url, proxy=None, max_size=16 * 1024 * 1024)
                sockets.append(socket)
                await socket.send(json.dumps({"type": "auth", "token": actor["token"]}))
                restored = await receive_type(socket, "restored")
                assert restored["room"]["code"] == room["code"]
                assert restored["match"]["id"] == before["id"]
                assert restored["match"]["revision"] == before["revision"]
                assert restored["match"]["snapshot"] == before["snapshot"]
                assert restored["match"]["currentPlayer"] == before["currentPlayer"]
                assert restored["match"]["lastShot"]["shotId"] == command["commandId"]
            after = (await request("GET", f"/api/matches/{match['id']}", a))["match"]
            assert after["snapshot"] == before["snapshot"]
            assert after["startedAt"] == before["startedAt"]
            assert (await request("GET", "/api/me", a))["user"]["displayName"] == "Recovery renamed A"
            assert (await request("GET", "/api/me/settings", a))["settings"] == settings
            telemetry_after = await request("GET", f"/api/matches/{match['id']}/telemetry", a)
            assert {entry["id"] for entry in telemetry_after["events"]} >= event_ids
            assert any(entry["type"] == "serverRecovery" for entry in telemetry_after["events"])
            assert len([entry for entry in telemetry_after["events"] if entry["type"] == "reconnect"]) >= 2
            duplicate = await request("POST", f"/api/matches/{match['id']}/commands", a, command)
            assert duplicate["duplicate"] is True
            assert duplicate["result"]["shotId"] == command["commandId"]
            assert (await request("POST", "/api/telemetry/events", a, {"events": [event]}))["duplicates"] == 1
            print("PASS both players restore identical snapshot/revision/shot; profiles, settings, telemetry and dedupe survive restart")
            for actor in (a, b):
                await request("POST", f"/api/rooms/{room['code']}/leave", actor)
            print("PASS disposable room cleanup")
        finally:
            await asyncio.gather(*(socket.close() for socket in sockets), return_exceptions=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_url")
    parser.add_argument("--ssh-host", required=True)
    parser.add_argument("--restart", action="store_true", help="Explicitly permit restarting the named dedicated service")
    args = parser.parse_args()
    if not args.restart:
        parser.error("--restart is required; no service was changed")
    asyncio.run(main(args.base_url, args.ssh_host))
