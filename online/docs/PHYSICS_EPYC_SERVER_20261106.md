# EPYC test server: physics measurements, 2026-11-06

The new test VM is substantially faster than the existing preview VPS.
Both real-worker probes passed the 2.5-second limit for the two saved heavy
shots, individually and as simultaneous pairs. The maximum across these
32 complete, exact results was **1.032026 s**, including IPC and full JSON.
This qualifies the measured serving path, not every possible shot or load.
The separate 14-case/basic-warmup deadline gate still has one failure.

## Hardware and isolation

- Test host: `82.47.145.40`, Ubuntu 24.04.5, Python 3.12.3.
- VM exposes 4 vCPU, `AMD EPYC-Genoa Processor`, approximately 8 GiB RAM.
  This is a KVM-reported model/topology, not evidence of dedicated physical
  cores or a particular unmasked processor SKU. No GPU was used.
- The SSH session and its cgroup ancestors reported `cpu.max=max 100000`;
  no guest-side CPU quota was found. Provider-side contention remains unknown.
- Benchmark files and runtime were isolated under `/opt/pooltool-physics-bench-20261106`.
  The directory contains the source snapshots, new venv, helpers, logs,
  separate homes/JIT caches and raw reports. It is retained for reproduction.
- Installed Python venv and headless import dependencies, then pinned runtime
  requirements. No OS package upgrades, app service, API, firewall change,
  account/SSH-key change, database or game migration was performed.
- Final listeners were SSH and local DNS only. Both probes stopped all their
  children; the recorded worker PIDs were also checked absent. SSH was closed.
  The existing game at `82.47.143.103:8790` was not changed by this test.

## Source and correctness

Independent pre-change baseline:
`fc9e96eea2076d01d11ba8b95287023079ac9f5e`.
Candidate: `3995270cf93429a08cee15939534ba0a03f9586c` (physics unchanged since
`a178eb9`). A full baseline source export was copied into a separate candidate
directory and overlaid with the candidate server/tests and two changed
Pooltool resolver files. Explicit import-path assertions checked isolation.
Both used the same new venv and pinned packages; no old-server venv was copied.

The independent baseline captured new-host goldens with legacy traversal.
Candidate checks compare complete result hashes, input/order hashes, rules,
events, final states and all 60 Hz playback frames. No tolerance, friction,
precision, sampling or event/termination limit was relaxed. Incomplete results,
timeouts and errors are failures, not fast samples.

This host produces 2,453 events for the weak dense fixture versus 2,439 on the
old Linux VM and 2,373 on Windows. The new-host independent oracle accounts for
platform/CPU floating-point differences; no cross-host comparison was weakened.

## Measured gates

| Probe | Complete exact results | Maximum calculation + full JSON | Outcome |
| --- | ---: | ---: | --- |
| Baseline, 14 cases, one timed repeat after golden capture | 14/14 | 0.945782 s | Reference timing only |
| Candidate, 14 cases x 3 after basic engine warmup | 42/42 | 2.529168 s | Deadline FAIL |
| Real two-worker pool, heavy shots x 3, individual + simultaneous | 12/12 | 0.873505 s | PASS |
| Fresh JIT-cache two-worker pool, heavy shots x 5, individual + simultaneous | 20/20 | 1.032026 s | PASS |

The standalone corpus includes each case's first invocation after only
`PhysicsEngine.warmup()`. Its first recorded dense shot took 2.495144 s plus
0.034023 s JSON: 29.17 ms over the limit. Its other repetitions took about
0.63–0.65 s before JSON. This failure is retained, not replaced by a best run.
Basic warmup itself took 27.787 s and is a separate startup measurement.

The real pool uses the candidate's default `init_physics`, unmodified by the
probe, including its
extended warmup, and waits for **both** workers to announce READY. There is no
per-case priming before measured player shots. Startup was 8.302 s with the
existing candidate cache and 37.529 s with a newly created empty JIT cache.
This is preparation before serving, not a player's shot delay. A deployment
must wait for actual worker readiness rather than accepting shots during JIT.

The first pipeline explicitly fixed Numba/OpenBLAS/OMP/MKL thread counts to 1
and used separate baseline/candidate HOME and caches. The additional fresh-cache
probe used the default shell environment: HOME=/root and those thread variables
unset, with a new explicit NUMBA_CACHE_DIR. Treat it as a separate startup
qualification, not an identically controlled timing comparison.

The baseline's timed repeats use the old production detector after reference
capture/per-case priming; they are not cold timings of the legacy scalar
reference. These measurements do not prove an N-fold candidate-code speedup.
The much faster CPU is the main demonstrated practical difference from the old
VPS, whose previous finite worker maximum was 9.401 s.

## Limits and next step

Worker timing includes queue/IPC and complete JSON, but excludes network,
database, oracle validation and the separate 500 ms playback lead. Only two
simultaneous calculations were tested; an unbounded queue cannot have a fixed
deadline. This is not a live end-to-end test or a universal worst-case SLA.

The server is a promising migration candidate for the measured two-worker
workload. Keep the full readiness gate, then separately verify the deployed
API/network path and supported concurrency before promising a user-visible
2.5-second bound. No game migration or backend deployment is authorized by this
test alone, and none was performed.

## Retained evidence and reproduction

Raw JSON is in [`physics_benchmark_epyc_20261106/`](physics_benchmark_epyc_20261106/):
baseline/candidate corpus, both worker probes, the new-host oracle, three
environment snapshots and the package list. Independent review verified counts,
golden hashes, timing maxima, the retained deadline failure and clean shutdown.

Source archive SHA-256 values, verified on the test host:

- Baseline: `ee70f366c1a244c9160cfbe0390769388c91c1ecf6338bb9ca0d93992956b0bd`.
- Candidate overlay: `ffe2324a30a86e7e204f1bd3ded4dae75df930c7ec9038fa372627d4c6bed409`.
- Benchmark helpers: `2ae6c0cb07f8f26c26b725260b427c1ee207ab143b10abe20c3269a4d9739f41`.

The retained host helper `helpers/epyc_run_benchmarks.sh` captures the exact
pipeline. Its final printf does not propagate individual gate failures: inspect
the individual exit codes and JSON, not the outer shell status. Baseline/candidate
reports are never overwritten by the probes. For additional runs use a new
report path, the same frozen source/oracle and explicit environment settings.

```sh
python -m online.tests.latency_stress --goldens SAME_HOST_GOLDENS.json \
  --repeats 3 --max-seconds 2.5 --report NEW-corpus.json
python -m online.tests.profile_worker_latency --goldens SAME_HOST_GOLDENS.json \
  --repeats 3 --max-seconds 2.5 --report NEW-workers.json
```
