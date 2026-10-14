"""Real-engine acceptance tests; no mock physics or fabricated event fixtures."""

import copy
import json
import math
import unittest
from unittest.mock import patch

import numpy as np
import pooltool as pt
from pooltool.evolution.event_based.detect.ball_ball import ball_ball_collision_time_2d

from online.server.physics import PhysicsEngine, PhysicsError


class PhysicsTests(unittest.TestCase):
    def corner_pot_state(self, target: str):
        state = PhysicsEngine.new_match(17)
        table = state["snapshot"]["table"]
        width, length = table["width"], table["length"]
        radius = state["snapshot"]["balls"][0]["radius"]
        for ball in state["system"]["balls"].values():
            ball["s"] = 4
            ball["rvw"] = [[0.0, 0.0, -0.1], [0.0] * 3, [0.0] * 3]
        for ball_id, x, y in (("cue", 0.4, length - 0.4), (target, 0.18, length - 0.18), ("9", width * 0.8, length * 0.2)):
            state["system"]["balls"][ball_id]["s"] = 0
            state["system"]["balls"][ball_id]["rvw"] = [[x, y, radius], [0.0] * 3, [0.0] * 3]
        state["rules"].update(shotNumber=1, callShotRequired=True, ballInHandRegion="none")
        return state

    def test_new_match_is_serializable_and_seeded(self):
        first = PhysicsEngine.new_match(22)
        second = PhysicsEngine.new_match(22)
        self.assertEqual(first, second)
        self.assertEqual(json.loads(json.dumps(first)), first)
        snapshot = first["snapshot"]
        self.assertEqual(len(snapshot["balls"]), 16)
        self.assertEqual(len(snapshot["table"]["pockets"]), 6)
        self.assertEqual(snapshot["currentPlayer"], 0)
        self.assertEqual(snapshot["ballInHandRegion"], "behind_line")
        self.assertFalse(snapshot["callShotRequired"])
        self.assertFalse(snapshot["needsPlacement"])

    def test_real_break_has_synchronized_trajectory_and_rule_result(self):
        state = PhysicsEngine.new_match(123)
        before = copy.deepcopy(state)
        cue = state["system"]["balls"]["cue"]["rvw"][0]
        table = state["snapshot"]["table"]
        phi = math.degrees(math.atan2(table["length"] * 0.75 - cue[1], table["width"] * 0.5 - cue[0]))
        result = PhysicsEngine.simulate(state, {"V0": 5.0, "phi": phi}, shooter=0)
        self.assertEqual(state, before, "Workers must not mutate persisted state")
        self.assertTrue(any(event["type"] == "ball_ball" for event in result["events"]))
        self.assertGreater(result["duration"], 0)
        frames = result["trajectory"]["frames"]
        self.assertGreater(len(frames), 2)
        self.assertEqual(frames[0]["t"], 0)
        self.assertAlmostEqual(frames[-1]["t"], result["duration"])
        self.assertTrue(all(a["t"] <= b["t"] for a, b in zip(frames, frames[1:])))
        for frame in frames:
            self.assertEqual(len(frame["balls"]), 16)
            for ball in frame["balls"]:
                self.assertTrue(all(math.isfinite(x) for x in ball["position"]))
                self.assertAlmostEqual(sum(q*q for q in ball["quaternion"]), 1, places=6)
        self.assertEqual(result["state"]["rules"]["shotNumber"], 1)
        self.assertEqual(result["finalState"], result["state"]["snapshot"])
        self.assertEqual(json.loads(json.dumps(result)), result)

    def test_real_miss_changes_turn_and_grants_ball_in_hand(self):
        state = PhysicsEngine.new_match(32)
        result = PhysicsEngine.simulate(state, {"V0": 0.2, "phi": 270}, shooter=0)
        self.assertTrue(result["rules"]["foul"])
        self.assertEqual(result["rules"]["nextPlayer"], 1)
        self.assertTrue(result["rules"]["ballInHand"])
        self.assertTrue(result["rules"]["needsPlacement"])
        self.assertTrue(result["rules"]["callShotRequired"])
        self.assertTrue(result["rules"]["foulReason"])

    def test_low_power_break_can_settle_a_dense_rack_without_truncation(self):
        state = PhysicsEngine.new_match(1010)
        cue = state["system"]["balls"]["cue"]["rvw"][0]
        table = state["snapshot"]["table"]
        phi = math.degrees(math.atan2(table["length"] * 0.75 - cue[1], table["width"] * 0.5 - cue[0]))
        result = PhysicsEngine.simulate(state, {"V0": 1, "phi": phi})
        self.assertGreater(result["duration"], 0)
        self.assertTrue(all(ball["state"] in (0, 4) for ball in result["finalState"]["balls"]))

    def test_real_called_pot_assigns_group_even_when_last_solid_goes_down(self):
        state = self.corner_pot_state("1")
        state["system"]["balls"]["8"]["s"] = 0
        state["system"]["balls"]["8"]["rvw"][0] = [0.4, 0.6, state["snapshot"]["balls"][0]["radius"]]
        result = PhysicsEngine.simulate(state, {"V0": 1.2, "phi": 135, "b": -0.35, "ballCall": "1", "pocketCall": "lt"})
        self.assertIn("1", [ball["ball"] for ball in result["potted"]])
        self.assertTrue(result["rules"]["legal"])
        self.assertFalse(result["rules"]["turnOver"])
        self.assertEqual(result["rules"]["groups"], ["solids", "stripes"])
        self.assertEqual(result["rules"]["hittable"], ["8"])

    def test_real_legal_eight_pot_wins_and_early_eight_pot_loses(self):
        state = self.corner_pot_state("8")
        state["rules"].update(groups=["solids", "stripes"], hittable=["8"])
        result = PhysicsEngine.simulate(state, {"V0": 1.2, "phi": 135, "b": -0.35, "ballCall": "8", "pocketCall": "lt"})
        self.assertTrue(result["rules"]["gameOver"])
        self.assertEqual(result["rules"]["winner"], 0)
        self.assertTrue(result["rules"]["legal"])

        early = self.corner_pot_state("8")
        early["rules"].update(groups=["solids", "stripes"], hittable=[str(i) for i in range(1, 8)])
        early["system"]["balls"]["1"]["s"] = 0
        early["system"]["balls"]["1"]["rvw"][0] = [0.4, 0.6, early["snapshot"]["balls"][0]["radius"]]
        lost = PhysicsEngine.simulate(early, {"V0": 1.2, "phi": 135, "b": -0.35, "ballCall": "1", "pocketCall": "lt"})
        self.assertTrue(lost["rules"]["gameOver"])
        self.assertEqual(lost["rules"]["winner"], 1)
        self.assertTrue(lost["rules"]["foul"])

    def test_invalid_parameters_and_out_of_turn_rejected(self):
        state = PhysicsEngine.new_match(4)
        for command in ({"V0": 100}, {"V0": float("nan")}, {"phi": float("inf")}, {"theta": 80}, {"a": 0.8, "b": 0.8}, {"cueBallId": "8"}):
            with self.subTest(command=command), self.assertRaises(PhysicsError):
                PhysicsEngine.simulate(state, command)
        with self.assertRaisesRegex(PhysicsError, "not this player's turn"):
            PhysicsEngine.simulate(state, {}, shooter=1)

    def test_cue_placement_respects_head_string_and_collisions(self):
        state = PhysicsEngine.new_match(4)
        table = state["snapshot"]["table"]
        placed = PhysicsEngine.place_cue_ball(state, table["width"] / 2, table["length"] / 8)
        self.assertNotEqual(placed["system"]["balls"]["cue"]["rvw"], state["system"]["balls"]["cue"]["rvw"])
        with self.assertRaisesRegex(PhysicsError, "head string"):
            PhysicsEngine.place_cue_ball(state, table["width"] / 2, table["length"] / 2)
        with self.assertRaises(PhysicsError):
            PhysicsEngine.place_cue_ball(state, 0, 0)
        free = PhysicsEngine.timeout(state)
        object_ball = free["system"]["balls"]["1"]["rvw"][0]
        with self.assertRaisesRegex(PhysicsError, "overlaps"):
            PhysicsEngine.place_cue_ball(free, object_ball[0], object_ball[1], shooter=1)

    def test_shot_clock_foul_and_called_shot_validation(self):
        state = PhysicsEngine.timeout(PhysicsEngine.new_match(4), shooter=0)
        self.assertEqual(state["snapshot"]["currentPlayer"], 1)
        self.assertEqual(state["snapshot"]["foulReason"], "Shot clock expired")
        with self.assertRaisesRegex(PhysicsError, "Place the cue ball"):
            PhysicsEngine.validate_shot(state, {}, shooter=1)
        state = PhysicsEngine.place_cue_ball(state, 0.4, 0.4, shooter=1)
        self.assertFalse(state["snapshot"]["needsPlacement"])
        self.assertTrue(state["snapshot"]["ballInHand"])
        with self.assertRaisesRegex(PhysicsError, "Call a ball"):
            PhysicsEngine.validate_shot(state, {}, shooter=1)
        with self.assertRaisesRegex(PhysicsError, "six table pockets"):
            PhysicsEngine.validate_shot(state, {"ballCall": "1", "pocketCall": "unknown"}, shooter=1)
        PhysicsEngine.validate_shot(state, {"ballCall": "1", "pocketCall": "lt"}, shooter=1)

    def test_equal_acceleration_uses_quadratic_collision_time(self):
        # Both balls roll in +x with exactly equal deceleration.  Relative
        # acceleration is zero, but the rear ball catches the front one.
        radius = 0.028575
        rear = np.array([[0.2, 0.3, radius], [1.0, 0.0, 0.0], [0.0, 1.0 / radius, 0.0]])
        front = np.array([[0.4, 0.3, radius], [0.5, 0.0, 0.0], [0.0, 0.5 / radius, 0.0]])
        time = ball_ball_collision_time_2d(
            rear, front, pt.constants.rolling, pt.constants.rolling,
            0.01, 0.01, 0.17, 0.17, 9.81, 9.81, radius,
        )
        self.assertAlmostEqual(time, (0.2 - 2 * radius) / 0.5, places=7)

    def test_real_head_on_draw_with_degenerate_polynomial_completes(self):
        state = self.corner_pot_state("1")
        state["system"]["balls"]["8"]["s"] = 0
        state["system"]["balls"]["8"]["rvw"][0] = [0.4, 0.6, state["snapshot"]["balls"][0]["radius"]]
        result = PhysicsEngine.simulate(state, {"V0": 0.8, "phi": 135, "b": -0.2, "ballCall": "1", "pocketCall": "lt"})
        self.assertGreater(result["duration"], 0)
        self.assertIn("1", [ball["ball"] for ball in result["potted"]])

    def test_limit_rejects_result_instead_of_accepting_truncated_physics(self):
        state = PhysicsEngine.new_match(123)
        with patch("online.server.physics.MAX_EVENTS", 1), self.assertRaisesRegex(PhysicsError, "limit"):
            PhysicsEngine.simulate(state, {"V0": 2, "phi": 90})


if __name__ == "__main__":
    unittest.main()
