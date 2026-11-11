"""Opt-in real two-process worker/IPC/full-JSON latency probe.

Run on an isolated staging host with an independent same-platform oracle::

    python -m online.tests.profile_worker_latency --goldens ORIGINAL-LINUX.json \
        --repeats 3 --max-seconds 2.5 --report NEW-worker-report.json

The actual PhysicsWorkers initializer/handler warms both children before timing.
Recorded and weak dense shots run separately, then as a simultaneous mixed pair.
Every result must match its complete golden, including all playback/events/rules.
No per-case priming, truncation, reduced precision or timeout-as-success is used.
The optional deadline is checked after full completion, not used as a kill limit.
This finite isolated probe is not an exhaustive or live-server capacity SLA.
No service, API, persistent database or other user's match is accessed.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import hashlib
import json
import math
import platform
import statistics
import time
from pathlib import Path

from online.server.physics import PhysicsEngine
from online.server.storage import encode
from online.server.worker import PhysicsWorkers
from online.tests.latency_corpus import FIXTURES, build_cases, digest, input_digest
from online.tests.latency_stress import safe_new_path, validate_result, write_new


CASE_NAMES = ("recorded_dense_1675", "weak_dense_break")


def _summary(samples):
    summaries = {}
    for phase in ("individual", "simultaneous"):
        summaries[phase] = {}
        for name in CASE_NAMES:
            completed = [sample for sample in samples
                         if sample["phase"] == phase and sample["case"] == name
                         and sample["status"] == "complete"]
            if not completed:
                continue
            entry = {"completeExactSamples": len(completed)}
            for metric in ("calculateIpcSeconds", "jsonSeconds", "completePlusJsonSeconds"):
                values = [sample[metric] for sample in completed]
                entry[metric] = {"median": statistics.median(values), "maximum": max(values)}
            summaries[phase][name] = entry
    return summaries


async def _measure(pool, case, phase, repetition, timeout, gate=None):
    if gate is not None:
        await gate.wait()
    sample = {"case": case.name, "phase": phase, "repetition": repetition,
              "status": "unverified"}
    started = time.perf_counter()
    try:
        result = await pool.calculate(case.state, case.shot, case.shooter, timeout=timeout)
        calculated = time.perf_counter()
        # Measure a complete non-canonical JSON serialization, not a cheaper
        # projection that omits fields required by the correctness comparison.
        packet = encode(result).encode("utf-8")
        encoded = time.perf_counter()
        sample.update(calculateIpcSeconds=calculated - started,
                      jsonSeconds=encoded - calculated,
                      completePlusJsonSeconds=encoded - started,
                      fullResultJsonBytes=len(packet))
        return sample, result
    except Exception as error:
        sample.update(status="error", errorType=type(error).__name__,
                      message=str(error), failedAfterSeconds=time.perf_counter() - started)
        return sample, None


def _verify(sample, result, case, expected, initial, maximum, failures):
    if result is None:
        failures.append({"case": case.name, "phase": sample["phase"],
                         "repetition": sample["repetition"], "kind": "worker-error",
                         "type": sample["errorType"], "message": sample["message"],
                         "elapsedSeconds": sample["failedAfterSeconds"]})
        return False
    try:
        validate_result(result, case)
        actual_digest = digest(result)
        if actual_digest != expected["resultSha256"]:
            raise AssertionError("Complete worker result differs from the independent pre-change golden")
        if case.state != initial or input_digest(case) != expected["inputSha256"]:
            raise AssertionError("Worker probe mutated its frozen input state/order/shot")
        sample.update(status="complete", exactEquality=True,
                      inputSha256=expected["inputSha256"], resultSha256=actual_digest,
                      events=len(result["events"]), duration=result["duration"],
                      frames=len(result["trajectory"]["frames"]))
        exceeded = maximum is not None and sample["completePlusJsonSeconds"] > maximum
        sample["deadlineExceeded"] = exceeded
        if exceeded:
            failures.append({"case": case.name, "phase": sample["phase"],
                             "repetition": sample["repetition"], "kind": "deadline",
                             "maximumSeconds": sample["completePlusJsonSeconds"],
                             "limitSeconds": maximum})
        print(json.dumps({"case": case.name, "phase": sample["phase"],
                          "repetition": sample["repetition"], "status": "complete",
                          "completePlusJsonSeconds": sample["completePlusJsonSeconds"],
                          "exactEquality": True, "deadlineExceeded": exceeded}), flush=True)
        return True
    except Exception as error:
        sample.update(status="error", errorType=type(error).__name__, message=str(error))
        failures.append({"case": case.name, "phase": sample["phase"],
                         "repetition": sample["repetition"], "kind": "validation-error",
                         "type": type(error).__name__, "message": str(error)})
        return False


async def _run(args, cases, goldens):
    pool = PhysicsWorkers(size=2)  # Real default init_physics/handler, not a stub.
    samples, pairs, failures = [], [], []
    initial = {case.name: copy.deepcopy(case.state) for case in cases}
    report = {"schema": 1, "python": platform.python_version(), "platform": platform.platform(),
              "workerCount": 2, "repeats": args.repeats,
              "requestedSamples": 4 * args.repeats,
              "perCasePriming": False, "workerTimeoutSeconds": args.calculation_timeout,
              "startupTimeoutSeconds": args.startup_timeout,
              "maximumSeconds": args.max_seconds,
              "scope": "Isolated real PhysicsWorkers, calculation including queue/IPC plus complete full-result JSON; excludes network, DB, playback lead and oracle validation",
              "note": "A finite warm probe, not an exhaustive/load SLA. Rejected/invalid/incomplete results never count as fast completions.",
              "samples": samples, "pairs": pairs, "failures": failures}
    startup = time.perf_counter()
    try:
        pool.start()
        deadline = startup + args.startup_timeout
        while pool.warm_count < 2:
            if time.perf_counter() >= deadline:
                raise TimeoutError("Both real physics workers did not become READY within the startup bound")
            await asyncio.sleep(.05)
        report["startupSeconds"] = time.perf_counter() - startup
        report["readyWorkerCount"] = pool.warm_count
        report["workerPids"] = sorted(child.pid for child in pool.children if child.is_alive())
        if len(report["workerPids"]) != 2:
            raise RuntimeError("Expected exactly two live warmed physics children")
        print(json.dumps({"workersReady": pool.warm_count,
                          "startupSeconds": report["startupSeconds"]}), flush=True)
        aborted = False
        for repetition in range(1, args.repeats + 1):
            for case in cases:
                sample, result = await _measure(pool, case, "individual", repetition,
                                                args.calculation_timeout)
                samples.append(sample)
                if not _verify(sample, result, case, goldens[case.name], initial[case.name],
                               args.max_seconds, failures):
                    aborted = True
                    break
            if aborted:
                break
        if not aborted:
            for repetition in range(1, args.repeats + 1):
                gate = asyncio.Event()
                tasks = [asyncio.create_task(_measure(pool, case, "simultaneous", repetition,
                                                       args.calculation_timeout, gate))
                         for case in cases]
                began = time.perf_counter()
                gate.set()
                completed = await asyncio.gather(*tasks)
                elapsed = time.perf_counter() - began
                # Correctness hashing/validation occurs only after both tasks
                # have stopped their latency clocks. Natural full-JSON event-loop
                # contention between the two results remains part of the probe.
                valid = True
                for case, (sample, result) in zip(cases, completed):
                    samples.append(sample)
                    valid = _verify(sample, result, case, goldens[case.name], initial[case.name],
                                    args.max_seconds, failures) and valid
                pairs.append({"repetition": repetition, "cases": list(CASE_NAMES),
                              "calculateAndJsonMakespanSeconds": elapsed,
                              "completeExact": valid})
                if not valid:
                    aborted = True
                    break
        report["abortedAfterNonDeadlineFailure"] = aborted
    except Exception as error:
        failures.append({"kind": "startup-or-probe-error", "type": type(error).__name__,
                         "message": str(error)})
        report.setdefault("startupSeconds", time.perf_counter() - startup)
    finally:
        children, pending = tuple(pool.children), tuple(pool.tasks)
        cleanup = time.perf_counter()
        pool.close()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        alive = [child.pid for child in children if child.is_alive()]
        report["cleanup"] = {"seconds": time.perf_counter() - cleanup,
                             "allChildrenStopped": not alive, "survivingPids": alive}
        if alive:
            failures.append({"kind": "cleanup-error", "message": "Own physics child did not stop"})
    complete = [sample for sample in samples if sample["status"] == "complete"]
    report["completeExactSamples"] = len(complete)
    report["maxSeconds"] = max((sample["completePlusJsonSeconds"] for sample in complete), default=None)
    report["summaries"] = _summary(samples)
    report["status"] = "PASS" if not failures and len(complete) == report["requestedSamples"] else "FAIL"
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--goldens", required=True, help="Independent unchanged same-platform oracle JSON")
    parser.add_argument("--report", required=True, help="New output path; existing files are never overwritten")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--max-seconds", type=float)
    parser.add_argument("--startup-timeout", type=float, default=240.)
    parser.add_argument("--calculation-timeout", type=float, default=60.)
    args = parser.parse_args(argv)
    if not 1 <= args.repeats <= 5:
        parser.error("Use --repeats 1..5")
    if any(not math.isfinite(value) or value <= 0 for value in
           [args.startup_timeout, args.calculation_timeout,
            *([] if args.max_seconds is None else [args.max_seconds])]):
        parser.error("Timeouts and an optional maximum must be finite positive seconds")
    if args.startup_timeout > 600 or args.calculation_timeout > 300:
        parser.error("Bound startup to at most 600s and each calculation to at most 300s")
    try:
        source = Path(args.goldens).resolve()
        encoded = source.read_bytes()
        oracle = json.loads(encoded)
        expected = oracle["cases"]
        cases = [case for case in build_cases(PhysicsEngine()) if case.name in CASE_NAMES]
        if tuple(case.name for case in cases) != CASE_NAMES:
            raise ValueError("Focused dense corpus cases are missing or reordered")
        for case in cases:
            value = expected[case.name]
            if value.get("status") != "complete" or input_digest(case) != value["inputSha256"]:
                raise ValueError(f"Frozen input/order for {case.name} disagrees with the supplied complete oracle")
        output = safe_new_path(args.report, [source, Path(__file__),
                               FIXTURES / "dense_break_20261106.json",
                               FIXTURES / "weak_dense_break_20261106.json"])
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))
    report = asyncio.run(_run(args, cases, expected))
    report.update(goldenPlatform=oracle.get("platform"),
                  goldenSourceCommit=oracle.get("sourceCommit"),
                  goldenFileSha256=hashlib.sha256(encoded).hexdigest())
    write_new(output, report)
    print(json.dumps({"status": report["status"], "completeExactSamples": report["completeExactSamples"],
                      "requestedSamples": report["requestedSamples"], "maxSeconds": report["maxSeconds"],
                      "failures": report["failures"], "report": str(output)}, indent=2))
    return 0 if report["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
