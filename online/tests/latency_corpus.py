"""Frozen-input adversarial web-physics corpus, not an exhaustive SLA proof.

All rack IDs, positions and dictionary tie order are explicit fixtures. Sparse
cases are explicit stationary arrangements, not engine-generated trajectories.
Only the public engine's legal cue controls are used. No event/sample limit is
lowered and rejected/incomplete simulations never count as fast completions.
"""
from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from online.server.physics import PhysicsEngine
from online.tests.test_detection_pairs import recorded_case

FIXTURES = Path(__file__).parent / "fixtures"


@dataclass
class LatencyCase:
    name: str
    tags: tuple[str, ...]
    state: dict
    shot: dict
    shooter: int = 0
    minimum_events: int = 0


def canonical_bytes(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def input_digest(case: LatencyCase) -> str:
    # Sorted JSON alone erases the tie-breaking order of the balls dictionary.
    return digest({"state": case.state, "ballOrder": list(case.state["system"]["balls"]),
                   "shot": case.shot, "shooter": case.shooter})


def _shot(**changes):
    return {"V0": 3.0, "phi": 90.0, "theta": 0.0, "a": 0.0, "b": 0.0, **changes}


def _sparse(engine, base, cue, target):
    state = copy.deepcopy(base)
    other_ids = [str(i) for i in range(2, 16)]
    positions = {"cue": cue, "1": target}
    positions.update({ball_id: (.15 + .21 * (index % 4), .8 + .2 * (index // 4))
                      for index, ball_id in enumerate(other_ids)})
    for ball_id, (x, y) in positions.items():
        state["system"]["balls"][ball_id]["rvw"] = [[round(x, 9), round(y, 9), .028575], [0.] * 3, [0.] * 3]
        state["system"]["balls"][ball_id]["s"] = 0
    state["rules"].update(shotNumber=1, turnNumber=1, ballInHandRegion="none", movable=[], needsPlacement=False)
    state["snapshot"] = engine.snapshot(state)
    return state


def build_cases(engine=None) -> list[LatencyCase]:
    engine = engine or PhysicsEngine()
    fixture, dense = recorded_case(engine)
    weak_fixture, weak = recorded_case(engine, FIXTURES / "weak_dense_break_20261106.json")
    # The centre-rack heading is frozen too; recomputing atan2 on another libm
    # would unnecessarily make an exact input depend on platform rounding.
    weak_shot = dict(weak_fixture["shot"])
    cases = [
        LatencyCase("recorded_dense_1675", ("recorded", "dense", "follow"), dense, fixture["shot"], minimum_events=1675),
        LatencyCase("weak_dense_break", ("dense", "slow-break", "near-rest-contacts"), weak, weak_shot, minimum_events=2000),
        LatencyCase("minimum_speed_miss", ("minimum-speed", "foul"), copy.deepcopy(dense), _shot(V0=.05, phi=270)),
        LatencyCase("slow_break", ("slow-break", "dense"), copy.deepcopy(dense), _shot(V0=.2, phi=fixture["shot"]["phi"])),
        LatencyCase("maximum_speed_break", ("maximum-speed", "dense"), copy.deepcopy(dense), _shot(V0=8, phi=fixture["shot"]["phi"])),
        LatencyCase("maximum_follow_break", ("maximum-speed", "maximum-spin", "dense"), copy.deepcopy(dense), _shot(V0=8, phi=fixture["shot"]["phi"], b=.9)),
        LatencyCase("maximum_draw_break", ("maximum-speed", "maximum-spin", "draw", "dense"), copy.deepcopy(dense), _shot(V0=8, phi=fixture["shot"]["phi"], b=-.9)),
        LatencyCase("maximum_side_spin", ("maximum-speed", "maximum-spin", "side", "dense"), copy.deepcopy(dense), _shot(V0=8, phi=fixture["shot"]["phi"], a=.9)),
        LatencyCase("maximum_elevation", ("maximum-speed", "maximum-elevation", "maximum-spin"), copy.deepcopy(dense), _shot(V0=8, phi=fixture["shot"]["phi"], theta=60, b=.9)),
        LatencyCase("grazing_ball", ("grazing", "near-degenerate"), _sparse(engine, dense, (.2, 1.1), (.25714999, 1.5)), _shot(V0=3, phi=90)),
        LatencyCase("near_parallel_rail", ("near-parallel", "rail", "near-degenerate"), _sparse(engine, dense, (.028675, 1.3), (.3, 1.7)), _shot(V0=4, phi=90.000001, a=.7)),
        LatencyCase("head_on_draw", ("draw", "degenerate-polynomial", "corner-pot"), _sparse(engine, dense, (.4, 1.5812), (.18, 1.8012)), _shot(V0=.8, phi=135, b=-.2)),
        LatencyCase("scratch_blocked_respot", ("scratch", "foul", "blocked-respot"), _sparse(engine, dense, (.2, .2), (.4953, .4953)), _shot(V0=1.2, phi=225)),
    ]
    after_foul = engine.timeout(copy.deepcopy(dense), shooter=0)
    after_foul = engine.place_cue_ball(after_foul, .3, .3, shooter=1)
    cases.append(LatencyCase("after_foul_placement", ("respot", "placement", "turn-one"), after_foul,
                             _shot(V0=1.2, phi=45, a=.1, b=.2), shooter=1))
    return cases
