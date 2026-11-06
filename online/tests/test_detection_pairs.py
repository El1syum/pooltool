"""Exact paired simulation regression for cache-miss-only detector traversal."""

import math
import json
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from online.server.physics import ENGINE, PhysicsEngine
from online.tests import reference_detection
from pooltool.evolution.event_based.detect import EventDetector


def legacy_traversal():
    stack = ExitStack()
    stack.enter_context(patch.object(ENGINE, "detector", EventDetector(is_3d=ENGINE.is_3d)))
    for name in (
        "get_next_ball_ball_event", "get_next_ball_linear_cushion_event",
        "get_next_ball_circular_cushion_event", "get_next_ball_pocket_event",
    ):
        stack.enter_context(patch("pooltool.evolution.event_based.detect.detector." + name, getattr(reference_detection, name)))
    return stack


def recorded_case(engine, path=None):
    path = Path(path) if path else Path(__file__).parent / "fixtures" / "dense_break_20261106.json"
    fixture = json.loads(path.read_text(encoding="utf-8"))
    state = engine.new_match(seed=fixture["seed"])
    for ball_id, x, y, z in fixture["balls"]:
        state["system"]["balls"][ball_id]["rvw"] = [[x, y, z], [0.0] * 3, [0.0] * 3]
        state["system"]["balls"][ball_id]["s"] = 0
    if "ballOrder" in fixture:
        balls = state["system"]["balls"]
        state["system"]["balls"] = {ball_id: balls[ball_id] for ball_id in fixture["ballOrder"]}
    state["snapshot"] = engine.snapshot(state)
    return fixture, state


class DetectionPairEquivalenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = PhysicsEngine()
        cls.engine.warmup()

    def test_real_shots_retain_exact_events_states_rules_and_all_playback_frames(self):
        variants = [
            (2.0, 0, 0, 0), (3.0, 0, 0, 0), (5.0, 0, 0, 0),
            (7.5, 0, 0, 0), (3.0, 5, 0, 0), (3.0, 0, -0.3, 0),
            (3.0, 0, 0.3, 0), (3.0, 0, 0, -0.3), (3.0, 0, 0, 0.3),
            (5.0, 5, 0.2, -0.2), (1.0, 0, 0, 0), (4.0, 0, 0.2, 0.2),
            (8.0, 0, 0.010456622993178786, 0.7999316589781771),
            (4.017094017094017, 0, -0.38961038961038963, 0),
            (8.0, 60, 0, .9), (.05, 0, 0, 0),
        ]
        for index, (speed, elevation, side, vertical) in enumerate(variants):
            with self.subTest(index=index, speed=speed, elevation=elevation, a=side, b=vertical):
                seed = (203464297 if index == 12 else 2459420161 if index == 13 else 1000 + index)
                state = self.engine.new_match(seed=seed)
                table = state["snapshot"]["table"]
                cue = state["system"]["balls"]["cue"]["rvw"][0]
                heading = math.degrees(math.atan2(table["length"] * .75 - cue[1], table["width"] * .5 - cue[0]))
                shot = {"V0": speed, "phi": heading, "theta": elevation, "a": side, "b": vertical}
                if index == 12:
                    shot["phi"] = 95.57054880617994
                elif index == 13:
                    shot["phi"] = 95.55270746141593
                with legacy_traversal():
                    expected = self.engine.simulate(state, shot)
                actual = self.engine.simulate(state, shot)
                self.assertEqual(actual, expected)
                if index == 10:
                    self.assertGreater(len(actual["events"]), 2000, "The weak-break stress case must remain dense")

    def test_recorded_dense_preview_break_reproduces_exactly_with_original_traversal(self):
        fixture, state = recorded_case(self.engine)
        with legacy_traversal():
            expected = self.engine.simulate(state, fixture["shot"])
        actual = self.engine.simulate(state, fixture["shot"])
        self.assertEqual(actual, expected)
        self.assertEqual(len(actual["events"]), fixture["observedEvents"])


if __name__ == "__main__":
    unittest.main()
