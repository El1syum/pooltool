"""Fast corpus/benchmark-contract tests; full simulations are an opt-in CLI gate."""
import copy
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

from online.server.physics import PhysicsEngine
from online.tests.latency_corpus import FIXTURES, build_cases, canonical_bytes, digest, input_digest
from online.tests.latency_stress import main, safe_new_path, validate_result


class LatencyCorpusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = build_cases()
        cls.goldens = json.loads((FIXTURES / "latency_golden_v1.json").read_text(encoding="utf-8"))["cases"]

    def test_frozen_state_order_and_controls_match_pre_change_inputs(self):
        self.assertEqual(len(self.cases), 14)
        self.assertEqual(set(self.goldens), {case.name for case in self.cases})
        for case in self.cases:
            with self.subTest(case=case.name):
                self.assertEqual(input_digest(case), self.goldens[case.name]["inputSha256"])
                PhysicsEngine.validate_shot(case.state, case.shot, case.shooter)
                self.assertEqual(len(case.state["system"]["balls"]), 16)
                self.assertEqual(len({tuple(ball["rvw"][0]) for ball in case.state["system"]["balls"].values()}), 16)

    def test_initial_arrangements_have_no_overlaps_or_ball_centres_in_pockets(self):
        for case in self.cases:
            with self.subTest(case=case.name):
                balls = list(case.state["snapshot"]["balls"])
                table = case.state["snapshot"]["table"]
                for index, ball in enumerate(balls):
                    x, y, z = ball["position"]; radius = ball["radius"]
                    self.assertGreaterEqual(x, radius - 1e-8)
                    self.assertGreaterEqual(y, radius - 1e-8)
                    self.assertLessEqual(x, table["width"] - radius + 1e-8)
                    self.assertLessEqual(y, table["length"] - radius + 1e-8)
                    self.assertAlmostEqual(z, radius, places=8)
                    for pocket in table["pockets"]:
                        self.assertGreater(math.hypot(x - pocket["center"][0], y - pocket["center"][1]), pocket["radius"])
                    for other in balls[index + 1:]:
                        self.assertGreaterEqual(math.dist(ball["position"], other["position"]), radius + other["radius"] - 1e-8)

    def test_hard_cases_cannot_silently_become_easy_or_change_turn(self):
        self.assertEqual(self.goldens["recorded_dense_1675"]["events"], 1675)
        self.assertEqual(self.goldens["weak_dense_break"]["events"], 2373)
        self.assertGreaterEqual(self.goldens["maximum_follow_break"]["events"], 1000)
        self.assertGreater(self.goldens["maximum_side_spin"]["duration"], 20)
        after = next(case for case in self.cases if case.name == "after_foul_placement")
        self.assertEqual(after.shooter, 1)
        self.assertEqual(after.state["rules"]["currentPlayer"], 1)
        self.assertFalse(after.state["rules"]["needsPlacement"])
        scratch = next(case for case in self.cases if case.name == "scratch_blocked_respot")
        self.assertEqual(scratch.state["system"]["balls"]["1"]["rvw"][0][:2], [.4953, .4953])

    def test_corpus_reaches_control_limits_and_near_degenerate_geometry(self):
        self.assertEqual(min(case.shot["V0"] for case in self.cases), .05)
        self.assertEqual(max(case.shot["V0"] for case in self.cases), 8)
        self.assertEqual(max(case.shot["theta"] for case in self.cases), 60)
        self.assertAlmostEqual(max(math.hypot(case.shot["a"], case.shot["b"]) for case in self.cases), .9)
        grazing = next(case for case in self.cases if case.name == "grazing_ball")
        cue = grazing.state["system"]["balls"]["cue"]["rvw"][0]
        target = grazing.state["system"]["balls"]["1"]["rvw"][0]
        self.assertAlmostEqual(target[0] - cue[0], 2 * .028575 - 1e-8, places=10)
        rail = next(case for case in self.cases if case.name == "near_parallel_rail")
        self.assertEqual(rail.shot["phi"], 90.000001)
        self.assertAlmostEqual(rail.state["system"]["balls"]["cue"]["rvw"][0][0], .028575 + .0001, places=10)

    def test_input_fingerprint_preserves_dictionary_tie_order_and_every_control(self):
        original = self.cases[0]; changed = copy.deepcopy(original)
        changed.state["system"]["balls"] = dict(reversed(list(changed.state["system"]["balls"].items())))
        self.assertNotEqual(input_digest(original), input_digest(changed))
        changed = copy.deepcopy(original); changed.shot["b"] += 1e-9
        self.assertNotEqual(input_digest(original), input_digest(changed))

    def test_result_fingerprint_detects_an_event_or_frame_removed(self):
        original = {"events": [{"time": .1}], "trajectory": {"frames": [{"t": 0}, {"t": .1}]}}
        changed = copy.deepcopy(original); changed["events"].clear()
        self.assertNotEqual(digest(original), digest(changed))
        changed = copy.deepcopy(original); changed["trajectory"]["frames"].pop()
        self.assertNotEqual(digest(original), digest(changed))
        with self.assertRaises(ValueError):
            canonical_bytes({"invalid": float("nan")})

    def test_benchmark_refuses_input_overwrite_and_existing_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source.json"; source.write_text("{}", encoding="utf-8")
            with self.assertRaises(ValueError):
                safe_new_path(source, [source])
            with self.assertRaises(FileExistsError):
                safe_new_path(source)
            if hasattr(os, "link"):
                alias = source.with_name("alias.json"); os.link(source, alias)
                with self.assertRaises(ValueError):
                    safe_new_path(alias, [source])
            self.assertEqual(safe_new_path(source.with_name("new.json"), [source]).name, "new.json")

    def test_settling_and_sampling_guard_rejects_a_truncated_result(self):
        case = next(case for case in self.cases if case.name == "minimum_speed_miss")
        result = {"events": [], "duration": 0, "finalState": {"balls": [{"state": 0}]},
                  "state": {"snapshot": {"balls": [{"state": 0}]}}, "trajectory": {"duration": 0, "dt": 1 / 60, "frames": [{"t": 0}]}}
        validate_result(result, case)
        truncated = copy.deepcopy(result); truncated["trajectory"]["dt"] = 1 / 30
        with self.assertRaisesRegex(AssertionError, "sampling"):
            validate_result(truncated, case)
        unsettled = copy.deepcopy(result); unsettled["finalState"]["balls"][0]["state"] = 2
        with self.assertRaisesRegex(AssertionError, "settled"):
            validate_result(unsettled, case)
        truncated = copy.deepcopy(result); truncated["duration"] = truncated["trajectory"]["duration"] = .1
        with self.assertRaisesRegex(AssertionError, "truncated"):
            validate_result(truncated, case)

    def test_first_candidate_invocation_is_timed_and_a_rejection_never_counts_as_fast(self):
        case = copy.deepcopy(next(case for case in self.cases if case.name == "minimum_speed_miss"))
        snapshot = {"balls": [{"state": 0}]}
        result = {"events": [], "duration": .1, "finalState": snapshot,
                  "state": {"snapshot": snapshot}, "trajectory": {"duration": .1, "dt": 1 / 60, "frames": [{"t": i / 60} for i in range(7)]}}
        with tempfile.TemporaryDirectory() as temporary:
            goldens = Path(temporary) / "goldens.json"
            goldens.write_text(json.dumps({"cases": {case.name: {"inputSha256": input_digest(case), "resultSha256": digest(result)}}}), encoding="utf-8")
            engine = MagicMock(); engine.simulate.return_value = result
            report = Path(temporary) / "success.json"
            with patch("online.tests.latency_stress.PhysicsEngine", return_value=engine), patch("online.tests.latency_stress.build_cases", return_value=[case]), redirect_stdout(io.StringIO()):
                self.assertEqual(main(["--goldens", str(goldens), "--repeats", "3", "--report", str(report)]), 0)
            self.assertEqual(engine.simulate.call_count, 3, "An unreported per-case prime must not hide first-use latency")
            measured = json.loads(report.read_text(encoding="utf-8"))
            self.assertTrue(measured["firstCaseInvocationIncluded"])
            self.assertEqual(len(measured["samples"][0]["simulateSeconds"]), 3)
            from online.server.physics import PhysicsError
            engine.simulate.reset_mock(); engine.simulate.side_effect = PhysicsError("Simulation limit")
            report = Path(temporary) / "rejected.json"
            with patch("online.tests.latency_stress.PhysicsEngine", return_value=engine), patch("online.tests.latency_stress.build_cases", return_value=[case]), redirect_stdout(io.StringIO()):
                self.assertEqual(main(["--goldens", str(goldens), "--repeats", "3", "--max-seconds", "2.5", "--report", str(report)]), 1)
            measured = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(measured["successfulCases"], 0)
            self.assertEqual(measured["samples"], [])
            self.assertEqual(measured["failures"][0]["kind"], "rejected")

    def test_nonfinite_or_nonpositive_deadline_fails_closed_before_any_simulation(self):
        for value in ("nan", "inf", "-inf", "0", "-1"):
            with self.subTest(value=value), patch("online.tests.latency_stress.PhysicsEngine") as engine, redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as failure:
                    main(["--max-seconds=" + value])
                self.assertEqual(failure.exception.code, 2)
                engine.assert_not_called()


if __name__ == "__main__":
    unittest.main()
