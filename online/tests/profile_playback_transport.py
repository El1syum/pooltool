"""Compare old/new playback projection against an already computed real result.

This probe does not simulate shots or access a server/persistent database. It
uses an isolated in-memory Store. Pass a JSON result saved by a real
PhysicsEngine run. Timings are local microbenchmarks, not an SLA.
"""

from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import statistics
import time

from online.server.service import GameService, playback_events
from online.server.storage import Store, encode


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("result", type=Path)
    parser.add_argument("--runs", type=int, default=40)
    args = parser.parse_args()
    if not 1 <= args.runs <= 200:
        parser.error("--runs must be between 1 and 200")
    result = json.loads(args.result.read_text(encoding="utf-8"))
    old_public = {key: value for key, value in result.items()
                  if key not in {"state", "trajectories"}}
    public = {**old_public, "events": playback_events(old_public["events"])}
    match = {"id": "profile-only", "disconnected": {},
             "playbackUntil": "2099-01-01T00:00:00Z",
             "lastShot": {"shotId": "profile-only", "result": old_public}}
    expired = {**match, "playbackUntil": None}
    store = Store(":memory:")
    service = GameService(store, None, process_pool=False, now=lambda: 100.0)

    def old_projection(value, *, sibling=False, finished=False):
        projected = copy.deepcopy(value)
        shot = projected["lastShot"]
        if sibling:
            shot.pop("result", None)
        elif finished:
            for key in ("trajectory", "trajectories", "initialState", "finalState"):
                shot["result"].pop(key, None)
        return projected

    cases = {
        "oldActiveProjection": lambda: old_projection(match),
        "newActiveLegacyProjection": lambda: service.public_match(match),
        "oldSiblingProjection": lambda: old_projection(match, sibling=True),
        "newSiblingProjection": lambda: service.public_match(match, include_last_result=False),
        "oldExpiredProjection": lambda: old_projection(expired, finished=True),
        "newExpiredProjection": lambda: service.public_match(expired),
        "oldThreeSocketEncoding": lambda: [encode(old_public) for _ in range(3)],
        "newSharedSocketEncoding": lambda: encode(public),
    }
    timings = {}
    try:
        for name, operation in cases.items():
            operation()
            samples = []
            for _ in range(args.runs):
                started = time.perf_counter()
                operation()
                samples.append((time.perf_counter() - started) * 1000)
            timings[name] = {"medianMs": round(statistics.median(samples), 3),
                             "maxMs": round(max(samples), 3)}
        audible = [event for event in old_public["events"]
                   if any(kind in event["type"]
                          for kind in ("pocket", "cushion", "ball_ball", "stick_ball"))]
        bins: dict[int, int] = {}
        for event in audible:
            index = int(event["time"] * 60)
            bins[index] = bins.get(index, 0) + 1
        print(json.dumps({
            "note": "Already computed real result; local CPU microbenchmark only",
            "runs": args.runs,
            "events": len(old_public["events"]),
            "audibleEvents": len(audible),
            "maxAudibleEventsPer60HzBin": max(bins.values(), default=0),
            "oldPublicBytes": len(encode(old_public).encode()),
            "newPublicBytes": len(encode(public).encode()),
            "oldEventBytes": len(encode(old_public["events"]).encode()),
            "newEventBytes": len(encode(public["events"]).encode()),
            "trajectoryBytes": len(encode(public["trajectory"]).encode()),
            "timings": timings,
        }, indent=2))
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
