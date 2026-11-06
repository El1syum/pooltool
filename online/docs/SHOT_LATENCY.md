# Shot latency — 2026-11-02

For the subsequent exact detector batching, transport/scheduling and smooth
playback update, see [2026-11-06 measurements](SHOT_PERFORMANCE_20261106.md).
The timings below remain the historical November 2 comparison.

The web service still uses the original authoritative Pooltool simulation,
collision resolver, rules and 60 Hz playback sampling. No event limit, physics
precision or simulated motion duration was reduced to make the UI feel faster.

## Change

`online/server/physics.py` now integrates playback quaternions with scalar math
instead of allocating several tiny NumPy arrays per sample. It prepares each
ball's delta frames separately and uses a vectorized mask to skip unchanged
position/state samples with zero angular velocity in both adjacent samples.
The frames and timestamps remain present, and their ball ordering is unchanged.
Pooltool copies even resting `rvw` arrays, so pointer identity is not a valid
way to recognize unchanged samples.

The regression tests compare against the exact previous trajectory builder and
an independent quaternion reference. Physical states, collision events, rules,
frame positions/states/timestamps and delta-entry counts match; only rotation
roundoff within the tested numerical tolerance is allowed. No upstream source
containing Numba functions was changed, avoiding cold recompilation on deploy.

An experimental cache-row detector was not retained: its small measured gain
did not justify duplicating upstream event orchestration and cache assumptions.

## Remote comparison

Host: the current `el1s` preview, `82.47.143.103`. Both implementations ran in
the same isolated Python process against identical states, with the service's
Numba cache and single-thread settings. Order alternated before/after then
after/before. These are medians of only two samples per case, not a load SLA.
Times include real simulation, playback preparation and rule-result building;
they exclude network transfer and playback duration. The live service and its
matches were not changed by the comparison.

| Control case | Events | Before | After |
| --- | ---: | ---: | ---: |
| Called corner pot, V0=1.2 | 8 | 0.155 s | 0.082 s |
| Seed 1000 break, V0=2.0 | 183 | 2.174 s | 0.960 s |
| Seed 1001 dense break, V0=3.0 | 792 | 6.091 s | 4.817 s |
| Seed 1002 break, V0=5.0 | 92 | 1.872 s | 1.323 s |

The dense break remains CPU-bound in the original collision simulation. The
optimization does not promise every shot below one second on this shared host.
Increasing worker count helps simultaneous games, not the execution time of an
individual shot, so that setting was left unchanged.

After deployment, the real-network reconnect/API probe passed; its dense random
break contained 1,101 events and still took 6.798 s. The deployed Chromium HUD
probe passed at the ordinary URL (16 textures, three matching final states,
zero JavaScript errors), with a different break taking 1.805 s on the server and
2.466 s from click to receipt. These random cases are not before/after pairs.
The remaining dense-rack latency is therefore a confirmed limitation, not a
claim that all calculation delays have been eliminated.

## Verification

```powershell
.\.venv\Scripts\python.exe -m pytest online/server/tests online/tests -q
.\.venv\Scripts\python.exe -m online.server.tests.live_probe http://127.0.0.1:8791
```

`online/client/tests/match-hud.mjs` also verifies `Cache-Control: no-store` on
the ordinary `/` URL and reports `serverWallSeconds` separately from
`clickToResultMs` and physical motion `duration`. It checks a real shot and
matching final states in the two players and observer.

The default preview URL is `http://82.47.143.103:8790/`, without `?v=0.2.0`.
Previously cached HTML may require one hard reload after the header fix; see
`online/ops/README.md`.

Verification for this change: 62 server/physics tests and 513 subtests pass;
the real-engine API/reconnect probe passes locally and remotely; HUD checks
pass in local Chromium/WebKit and deployed Chromium. The first remote HUD
attempt encountered a transport-level fetch failure; the retry passed.
