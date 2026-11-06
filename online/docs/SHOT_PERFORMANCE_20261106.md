# Shot calculation and playback — 2026-11-06

## Reproduced report

The preview telemetry confirmed a real 12.699-second computation with 1,675
events and 5.828306948 seconds of physical motion. Its anonymized initial
positions, dictionary order and cue parameters are in
`../tests/fixtures/dense_break_20261106.json`. Seed alone is insufficient for an
exact cross-process replay: rack ID assignment also depends on dictionary order.
The original warmed remote engine reproduced the case at 10.946/11.819 seconds.

Final paired comparison on the preview host, three alternating runs per version
after warming both paths, against exactly the same recorded input:

| Metric | Original detector | Online batched detector |
| --- | ---: | ---: |
| Median complete calculation | 9.710 s | 7.557 s |
| Events / physical duration | 1,675 / 5.828306948 s | identical |

This is a 1.285× speedup (22.2% less calculation time), not a load SLA. Complete
results compare equal, including events, rules, final state and playback frames.
The earlier single 12.699-second observation includes different runtime/load
conditions and is not substituted for the paired baseline.

## Changes

- The web engine alone selects `OnlineEventDetector`: exact planar coefficients
  are reused per ball and the existing root calculations are batched through
  Numba. No fastmath, friction, event epsilon, solver precision, sampling rate or
  simulation limit changed. The scalar kernels remain untouched as independent
  references and as the 3D/heterogeneous fallback.
- Collision times retain their original insertion/tie order; an indexed cache
  revisits actual missing pairs and invalidates affected rows. It supports normal
  dictionary mutation, partial retries, copy/pickle and layout replacement.
  Frozen/read-only geometry and parameters are retained with strong references.
- Playback messages carry compact event identities/times/IDs; complete before/
  after vectors remain in authoritative results and participant telemetry. On the
  same 792-event result, public JSON shrank from 599,339 to 242,056 bytes (59.6%).
  Match projections discard omitted heavy data before copying, and a broadcast
  is encoded once for all sockets, preserving per-socket ordering/timeouts.
- Diagnostic serialization precedes shared-start scheduling. The playback lead
  defaults to 500 ms instead of 120 ms; starts and deadlines remain identical for
  every participant. Staged three-client tests previously received data 111–243 ms
  late; after the fix all six deliveries had 175–300 ms of positive lead.
- Recordings are immutable/raw Vue data. The renderer uses reusable interpolation
  buffers and a monotonic rAF clock anchored once to the calibrated server epoch.
  Clock corrections cannot jump or prematurely finish a shot. Future starts hold
  both physical state and event audio; late joins still catch up authoritatively.
- Four procedural audio waveforms are cached; simultaneous same-kind contacts
  are coalesced, with at most 24 active voices and explicit disposal. Physical
  collisions are not discarded or merged.
- Worker warmup covers follow/side spin and an elevated cue before READY. Two
  physics workers can serve separate games without creating a second ASGI/state
  authority; the audited preview has six vCPUs and 12 GiB RAM.

## Verification

The complete server/online/event-based test selection passed 223 tests and 536
subtests. It includes 60,000 exact pointwise comparisons, 16 complete shot variants,
the recorded 1,675-event case and a 2,373-event weak break, plus 3D fallback,
partial caches, heterogeneous radii and geometry/parameter replacement.

Client unit/SSR checks: 92 pass. Actual Three.js playback was compared with the
reference at every one of 351 real frames and intermediate times, including
±20-second wall-clock adjustments, future starts and late catch-up. Native
Chromium audio used four buffers and no more than five concurrent voices in the
recorded case; headless WebKit's unavailable native audio is reported explicitly.
Cursor-resume and actual-App regressions passed both browsers without accidental
shots. The final three-client real-physics/HUD/menu scenario passed Chromium and
WebKit, with matching final states and no JavaScript/static-resource errors.

An isolated two-game/four-shot concurrency probe reported p50 173 ms and maximum
261 ms on the development machine. It is not a production capacity SLA. Headless
software-GPU frame timings likewise are not a physical-device FPS guarantee.

## Repeating measurements

`python -m online.tests.profile_detection --case-json
online/tests/fixtures/dense_break_20261106.json --repeats 3` alternates both
implementations in the same process after warming both. The baseline uses the
actual original four detector functions archived in `reference_detection.py`;
every complete result must compare equal before timings are reported.

`profile_playback_transport.py` accepts an actual saved engine result and isolates
projection/encoding costs. `client/tests/playback-smooth.mjs` requires an actual
result through `SHOT_RESULT_PATH`; `match-hud.mjs` reports packet size and both
prepared and clock-calibrated delivery lead.

Dense racks remain CPU-bound; no claim that every possible shot is instantaneous
or below one second is made. Very slow networks/background clients still use
authoritative catch-up. Simulation results are never truncated or fabricated
to meet a timing target.
