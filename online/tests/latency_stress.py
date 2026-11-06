"""Opt-in exact-golden stress/timing gate on a finite adversarial corpus.

Capture pre-change reference once: --capture-goldens NEW.json --repeats 1.
Afterward: --repeats 3 --max-seconds 2.5 --report NEW.json. Golden and report
outputs never overwrite existing files or inputs. Report per-case maximum warm
complete simulate and JSON-encoding time separately. This is not a proof about
all mathematically possible legal shots, arbitrary server load or cold startup.
The checked-in oracle was captured on Windows; Linux must supply --goldens with
its own unchanged-target reference. Never loosen numeric equality for a mismatch.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import platform
import statistics
import time
from pathlib import Path

from online.server.physics import PhysicsEngine, PhysicsError
from online.tests.latency_corpus import FIXTURES, build_cases, canonical_bytes, digest, input_digest
from online.tests.test_detection_pairs import legacy_traversal


def safe_new_path(path, inputs=()):
    target = Path(path).resolve()
    for item in inputs:
        source = Path(item).resolve()
        if os.path.normcase(str(source)) == os.path.normcase(str(target)):
            raise ValueError("Output must not overwrite an input")
        if source.exists() and target.exists() and os.path.samefile(source, target):
            raise ValueError("Output must not alias an input")
    if target.exists():
        raise FileExistsError("Output already exists; choose a new artifact path")
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def write_new(path, value):
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")


def validate_result(result, case):
    if len(result["events"]) < case.minimum_events:
        raise AssertionError(f"{case.name}: stress input no longer has its required event density")
    if case.name == "recorded_dense_1675" and len(result["events"]) != 1675:
        raise AssertionError("Recorded case no longer reproduces its exact 1,675 events")
    if not all(ball["state"] in (0, 4) for ball in result["finalState"]["balls"]):
        raise AssertionError(f"{case.name}: result is not fully settled")
    if result["state"]["snapshot"] != result["finalState"]:
        raise AssertionError("Packed authoritative final state disagrees with result")
    if result["trajectory"]["dt"] != 1 / 60:
        raise AssertionError("Playback sampling changed to meet the timing goal")
    trajectory = result["trajectory"]
    frames = trajectory["frames"]
    if not frames or frames[0]["t"] != 0:
        raise AssertionError("Complete playback must begin at t=0")
    if not math.isfinite(result["duration"]) or result["duration"] < 0 or trajectory["duration"] != result["duration"]:
        raise AssertionError("Invalid or mismatched physical duration")
    if abs(frames[-1]["t"] - result["duration"]) > 1e-5:
        raise AssertionError("Playback was truncated before the physical result")
    if any(not 0 <= after["t"] - before["t"] <= trajectory["dt"] + 1e-5 for before, after in zip(frames, frames[1:])):
        raise AssertionError("Playback skipped 60Hz samples or moved backwards")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-goldens")
    parser.add_argument("--reference-commit", help="Optional exact source revision recorded when capturing a new oracle")
    parser.add_argument("--goldens", default=str(FIXTURES / "latency_golden_v1.json"))
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--case", action="append", default=[])
    parser.add_argument("--max-seconds", type=float)
    parser.add_argument("--report")
    parser.add_argument("--outputs-dir")
    args = parser.parse_args(argv)
    if (not 1 <= args.repeats <= 20 or args.max_seconds is not None
            and (not math.isfinite(args.max_seconds) or args.max_seconds <= 0)):
        parser.error("Use repeats 1..20 and a finite positive optional maximum")
    sources = [FIXTURES / "dense_break_20261106.json", FIXTURES / "weak_dense_break_20261106.json", Path(__file__), Path(__file__).with_name("latency_corpus.py")]
    if not args.capture_goldens:
        sources.append(Path(args.goldens))
    destinations = []
    for value in (args.capture_goldens, args.report):
        if value:
            destinations.append(safe_new_path(value, [*sources, *destinations]))
    capture_path = Path(args.capture_goldens).resolve() if args.capture_goldens else None
    report_path = Path(args.report).resolve() if args.report else None
    engine = PhysicsEngine()
    cases = build_cases(engine)
    unknown = set(args.case) - {case.name for case in cases}
    if unknown:
        parser.error("Unknown case(s): " + ", ".join(sorted(unknown)))
    if args.case:
        cases = [case for case in cases if case.name in args.case]
    golden_document = {} if capture_path else json.loads(Path(args.goldens).read_text(encoding="utf-8"))
    goldens = golden_document.get("cases", {})
    warm_started = time.perf_counter(); engine.warmup(); warm_seconds = time.perf_counter() - warm_started
    records, failures, samples = {}, [], []
    outputs = None
    if args.outputs_dir:
        outputs = Path(args.outputs_dir).resolve()
        outputs.mkdir(parents=True, exist_ok=False)
    for case in cases:
        print(f"CASE {case.name}", flush=True)
        initial = copy.deepcopy(case.state)
        try:
            first_simulate = first_json = None
            if capture_path:
                with legacy_traversal():
                    reference = engine.simulate(case.state, case.shot, case.shooter)
                validate_result(reference, case)
            else:
                expected = goldens[case.name]
                if input_digest(case) != expected["inputSha256"]:
                    raise AssertionError("Frozen input state/order/shot changed")
                # Include the first candidate solve of each case: an unreported
                # per-case prime would hide a missing worker/JIT warmup branch.
                started = time.perf_counter()
                reference = engine.simulate(case.state, case.shot, case.shooter)
                first_simulate = time.perf_counter() - started
                started = time.perf_counter(); packet = canonical_bytes(reference); first_json = time.perf_counter() - started
                if digest(reference) != expected["resultSha256"]:
                    raise AssertionError("Complete result differs from independent pre-change golden")
                validate_result(reference, case)
            if case.state != initial:
                raise AssertionError("Simulation mutated the persisted input")
            if outputs:
                write_new(safe_new_path(outputs / (case.name + ".json"), sources), reference)
            record = {"inputSha256": input_digest(case), "resultSha256": digest(reference),
                      "events": len(reference["events"]), "duration": reference["duration"],
                      "frames": len(reference["trajectory"]["frames"]), "tags": list(case.tags), "status": "complete"}
            records[case.name] = record
            elapsed = [first_simulate] if first_simulate is not None else []
            encodings = [first_json] if first_json is not None else []
            for _ in range(args.repeats - len(elapsed)):
                started = time.perf_counter()
                actual = engine.simulate(case.state, case.shot, case.shooter)
                elapsed.append(time.perf_counter() - started)
                started = time.perf_counter(); packet = canonical_bytes(actual); encodings.append(time.perf_counter() - started)
                if digest(actual) != record["resultSha256"] or actual != reference:
                    raise AssertionError("Timed result differs from complete reference")
                validate_result(actual, case)
                if case.state != initial:
                    raise AssertionError("Simulation mutated the persisted input")
            sample = {"case": case.name, **record, "simulateSeconds": elapsed, "simulateMaxSeconds": max(elapsed),
                      "simulateMedianSeconds": statistics.median(elapsed), "jsonSeconds": encodings,
                      "simulatePlusJsonMaxSeconds": max(a + b for a, b in zip(elapsed, encodings)), "jsonBytes": len(packet), "exactEquality": True}
            samples.append(sample)
            print(json.dumps({"case": case.name, "events": record["events"], "maxSeconds": sample["simulateMaxSeconds"], "exactEquality": True}), flush=True)
            if args.max_seconds is not None and sample["simulatePlusJsonMaxSeconds"] > args.max_seconds:
                failures.append({"case": case.name, "kind": "deadline", "maximumSeconds": sample["simulatePlusJsonMaxSeconds"], "limitSeconds": args.max_seconds})
        except Exception as failure:
            # A legal request that errors, times out or hits a physics limit is
            # explicitly a failed completion, never a fast latency sample.
            failures.append({"case": case.name, "kind": "rejected" if isinstance(failure, PhysicsError) else "error",
                             "type": type(failure).__name__, "message": str(failure)})
            print(json.dumps(failures[-1]), flush=True)
    result = {"schema": 1, "python": platform.python_version(), "platform": platform.platform(),
              "goldenPlatform": golden_document.get("platform"), "goldenSourceCommit": golden_document.get("sourceCommit"),
              "cacheNote": "Existing caches preserved; single-process warm finite corpus, no universal/load SLA",
              "firstCaseInvocationIncluded": not bool(capture_path),
              "warmupSeconds": warm_seconds, "repeats": args.repeats, "requestedCases": len(cases),
              "successfulCases": len(samples), "maxSeconds": max((s["simulatePlusJsonMaxSeconds"] for s in samples), default=None),
              "samples": samples, "failures": failures}
    if capture_path:
        # Partial/failed captures must not become an apparently valid oracle.
        if not failures:
            write_new(capture_path, {"schema": 1, "reference": "Pre-change legacy scalar detector; complete engine result including all 60Hz frames, events and rules",
                                     "sourceCommit": args.reference_commit, "platform": platform.platform(),
                                     "python": platform.python_version(), "cases": records})
    if report_path:
        write_new(report_path, result)
    print(json.dumps({"requestedCases": len(cases), "successfulCases": len(samples), "failures": failures, "maxSeconds": result["maxSeconds"]}, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
