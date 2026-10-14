"""Concurrent-match load probe against a running service (real physics).

    python -m online.server.tests.load_probe --url http://127.0.0.1:8790 --matches 4 --shots 3

Each simulated match has two guest players who alternate legal shots (placing
the cue ball and calling a ball/pocket when the rules require it).  The probe
reports click-to-confirmed-result latency and response size; it is a capacity
check for one host, not a substitute for production monitoring.  Start the
service with ``GUEST_LOGINS_PER_MINUTE`` above ``2 * matches``: the default
guest-login rate limit (20 per minute per IP) otherwise rejects the probe.
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
import time
import uuid

import httpx


async def guest(client, name):
    response = await client.post("/api/auth/guest", json={"displayName": name, "clientVersion": "load-probe"})
    response.raise_for_status()
    return {"Authorization": "Bearer " + response.json()["token"]}


async def play(client, index, shots, latencies, sizes):
    first, second = await guest(client, f"Load-{index}-A"), await guest(client, f"Load-{index}-B")
    room = (await client.post("/api/rooms", headers=first, json={"settings": {"turnSeconds": 180}})).json()["room"]
    (await client.post(f"/api/rooms/{room['code']}/join", headers=second)).raise_for_status()
    await client.post(f"/api/rooms/{room['code']}/ready", headers=first, json={"ready": True})
    match = (await client.post(f"/api/rooms/{room['code']}/ready", headers=second, json={"ready": True})).json()["match"]
    players = (first, second)
    endpoint = f"/api/matches/{match['id']}/commands"
    for _ in range(shots):
        match = (await client.get(f"/api/matches/{match['id']}", headers=first)).json()["match"]
        if match["status"] == "finished":
            return
        until = match.get("playbackUntil")
        if until:
            from datetime import datetime
            delay = datetime.fromisoformat(until.replace("Z", "+00:00")).timestamp() - time.time()
            await asyncio.sleep(max(0, delay) + 0.1)
        headers = players[match["currentPlayer"]]
        snapshot = match["snapshot"]
        if snapshot.get("needsPlacement"):
            for x, y in ((0.3, 0.3), (0.7, 0.4), (0.5, 0.2), (0.2, 0.6)):
                placed = await client.post(endpoint, headers=headers, json={"commandId": uuid.uuid4().hex, "expectedRevision": match["revision"],
                                                                           "type": "placeCueBall", "payload": {"x": x, "y": y}})
                if placed.status_code == 200:
                    match = placed.json()["match"]
                    break
        payload = {"V0": 3.0, "phi": 80.0 + 7 * index}
        if snapshot.get("callShotRequired"):
            payload.update(ballCall=snapshot["hittable"][0], pocketCall="lt")
        started = time.perf_counter()
        response = await client.post(endpoint, headers=headers, json={"commandId": uuid.uuid4().hex, "expectedRevision": match["revision"],
                                                                     "type": "shot", "payload": payload})
        if response.status_code == 422:
            # A rule rejection (e.g. no legal placement found) is not a capacity sample.
            print("rejected:", response.json().get("detail"))
            continue
        response.raise_for_status()
        latencies.append(time.perf_counter() - started)
        sizes.append((len(response.content), response.num_bytes_downloaded))


async def main(url, matches, shots):
    latencies, sizes = [], []
    async with httpx.AsyncClient(base_url=url, timeout=120, headers={"Accept-Encoding": "gzip"}) as client:
        started = time.perf_counter()
        await asyncio.gather(*(play(client, index, shots, latencies, sizes) for index in range(matches)))
        elapsed = time.perf_counter() - started
    latencies.sort()
    print({"matches": matches, "shots": len(latencies), "elapsedSeconds": round(elapsed, 1),
           "p50Seconds": round(statistics.median(latencies), 3),
           "p95Seconds": round(latencies[max(0, int(len(latencies) * 0.95) - 1)], 3),
           "maxSeconds": round(latencies[-1], 3),
           "medianResponseKB": round(statistics.median(raw for raw, _ in sizes) / 1024, 1),
           "medianWireKB": round(statistics.median(wire for _, wire in sizes) / 1024, 1)})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8790")
    parser.add_argument("--matches", type=int, default=4)
    parser.add_argument("--shots", type=int, default=3)
    arguments = parser.parse_args()
    asyncio.run(main(arguments.url, arguments.matches, arguments.shots))
