"""Alternating same-process detector benchmark; no matches or caches are deleted.

Run ``python -m online.tests.profile_detection --repeats 3``. The baseline uses
the independent legacy full-pair traversal, with identical collision kernels,
rules, serialized initial state and playback preparation. Each pair is asserted
exactly equal before its timings are reported. This is not a concurrency SLA.
"""

import argparse
import json
import math
import statistics
import time

from online.server.physics import PhysicsEngine
from online.tests.test_detection_pairs import legacy_traversal, recorded_case


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--case-json", help="Recorded {seed, shot, balls:[[id,x,y,z],...]} physical inputs only")
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10:
        parser.error("--repeats must be 1..10")
    engine = PhysicsEngine()
    engine.warmup()
    samples = []
    cases = []
    for seed, speed, heading, side, vertical in ([] if args.case_json else [
        (1000, 2.0, None, 0, 0), (1001, 3.0, None, 0, 0),
        (203464297, 8.0, 95.57054880617994, .010456622993178786, .7999316589781771),
        (2459420161, 4.017094017094017, 95.55270746141593, -.38961038961038963, 0),
    ]):
        state = engine.new_match(seed=seed)
        table = state["snapshot"]["table"]
        cue = state["system"]["balls"]["cue"]["rvw"][0]
        if heading is None:
            heading = math.degrees(math.atan2(table["length"] * .75 - cue[1], table["width"] * .5 - cue[0]))
        shot = {"V0": speed, "phi": heading, "a": side, "b": vertical, "theta": 0}
        cases.append((seed, state, shot))
    fixture, state = recorded_case(engine, args.case_json)
    cases.append((fixture["seed"], state, fixture["shot"]))
    for seed, state, shot in cases:
        # Prime all lazily loaded JIT/resolver branches before paired timing.
        reference = engine.simulate(state, shot)
        with legacy_traversal():
            assert engine.simulate(state, shot) == reference
        before, after = [], []
        for index in range(args.repeats):
            for legacy in ([True, False] if index % 2 == 0 else [False, True]):
                started = time.perf_counter()
                if legacy:
                    with legacy_traversal():
                        result = engine.simulate(state, shot)
                else:
                    result = engine.simulate(state, shot)
                (before if legacy else after).append(time.perf_counter() - started)
                assert result == reference
        old, new = statistics.median(before), statistics.median(after)
        samples.append({"seed": seed, "events": len(reference["events"]), "duration": reference["duration"],
                        "beforeMs": round(old * 1000, 3), "afterMs": round(new * 1000, 3),
                        "speedup": round(old / new, 3), "exactEquality": True})
    print(json.dumps({"repeats": args.repeats, "samples": samples}, indent=2))


if __name__ == "__main__":
    main()
