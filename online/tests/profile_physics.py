"""Bounded, real-engine timing probe (does not alter matches or delete caches).

Run from the repository root:
    .venv/Scripts/python.exe -m online.tests.profile_physics --shots 12

Startup includes imports plus a real warmup shot.  It reflects the cache state of
this machine; it is not advertised as a clean-cache or production load test.
Shot timings include trajectory/orientation and rule-result serialization work.
"""

from __future__ import annotations

import argparse
import json
import math
import platform
import statistics
import time

IMPORT_STARTED = time.perf_counter()
from online.server.physics import PhysicsEngine  # noqa: E402


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    point = (len(ordered) - 1) * fraction
    low = math.floor(point)
    high = math.ceil(point)
    return ordered[low] + (ordered[high] - ordered[low]) * (point - low)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shots", type=int, default=12)
    args = parser.parse_args()
    if not 1 <= args.shots <= 100:
        parser.error("--shots must be between 1 and 100")

    engine = PhysicsEngine()
    import_seconds = time.perf_counter() - IMPORT_STARTED
    warmup_started = time.perf_counter()
    engine.warmup()
    warmup_seconds = time.perf_counter() - warmup_started
    wall_times, durations, sizes, samples, errors = [], [], [], [], []
    variants = [
        (2.0, 0, 0, 0), (3.0, 0, 0, 0), (5.0, 0, 0, 0),
        (7.5, 0, 0, 0), (3.0, 5, 0, 0), (3.0, 0, -0.3, 0),
        (3.0, 0, 0.3, 0), (3.0, 0, 0, -0.3), (3.0, 0, 0, 0.3),
        (5.0, 5, 0.2, -0.2), (1.0, 0, 0, 0), (4.0, 0, 0.2, 0.2),
    ]
    for index in range(args.shots):
        state = engine.new_match(seed=1000 + index)
        table = state["snapshot"]["table"]
        cue = state["system"]["balls"]["cue"]["rvw"][0]
        phi = math.degrees(math.atan2(table["length"] * 0.75 - cue[1], table["width"] * 0.5 - cue[0]))
        V0, theta, a, b = variants[index % len(variants)]
        started = time.perf_counter()
        try:
            result = engine.simulate(state, {"V0": V0, "phi": phi, "theta": theta, "a": a, "b": b})
            wall_ms = (time.perf_counter() - started) * 1000
            wall_times.append(wall_ms)
            durations.append(result["duration"])
            public = {key: value for key, value in result.items() if key not in ("state", "trajectories")}
            size = len(json.dumps(public, separators=(",", ":"), allow_nan=False).encode())
            sizes.append(size)
            samples.append({
                "seed": state["seed"], "V0": V0, "theta": theta, "a": a, "b": b,
                "wallMs": round(wall_ms, 2), "playbackSeconds": result["duration"],
                "frames": len(result["trajectory"]["frames"]), "payloadBytes": size,
            })
        except Exception as error:
            errors.append({"seed": state["seed"], "type": type(error).__name__, "error": str(error)})
    output = {
        "python": platform.python_version(), "platform": platform.platform(),
        "startupImportMs": round(import_seconds * 1000, 2),
        "startupWarmupMs": round(warmup_seconds * 1000, 2),
        "requestedShots": args.shots, "successfulShots": len(wall_times),
        "cacheNote": "Existing Numba caches preserved; timings are local, not a concurrency load test",
        "wallMs": {
            "p50": round(statistics.median(wall_times), 2),
            "p95": round(percentile(wall_times, 0.95), 2),
            "max": round(max(wall_times), 2),
        } if wall_times else None,
        "maxPlaybackSeconds": max(durations) if durations else None,
        "maxPublicPayloadBytes": max(sizes) if sizes else None,
        "samples": samples, "errors": errors,
    }
    print(json.dumps(output, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
