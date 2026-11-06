"""Playback-math regression tests independent of the collision simulation.

The NumPy reference deliberately uses a quaternion multiplication matrix rather
than the scalar implementation under test. These tests guard optimizations of
trajectory preparation without changing authoritative physics or its sampling.
"""

import copy
import math
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np

import pooltool as pt
from online.server.physics import PLAYBACK_DT, PhysicsEngine, _quaternion_step


def _reference_step(quaternion, angular_velocity, dt):
    omega = np.asarray(angular_velocity, dtype=np.float64)
    magnitude = np.linalg.norm(omega)
    if magnitude < 1e-10 or dt <= 0:
        return list(quaternion)
    half_angle = magnitude * dt / 2
    dx, dy, dz = omega / magnitude * math.sin(half_angle)
    dw = math.cos(half_angle)
    # Left multiplication by the world-space incremental rotation [dx,dy,dz,dw].
    product = np.array([
        [dw, -dz, dy, dx],
        [dz, dw, -dx, dy],
        [-dy, dx, dw, dz],
        [-dx, -dy, -dz, dw],
    ], dtype=np.float64) @ np.asarray(quaternion, dtype=np.float64)
    product /= np.linalg.norm(product)
    return [round(float(value), 9) for value in product]


def _state(timestamp, position, angular_velocity, state):
    return SimpleNamespace(
        t=timestamp,
        s=state,
        rvw=np.array([position, [0.0, 0.0, 0.0], angular_velocity], dtype=np.float64),
    )


def _legacy_quaternion_step(quaternion, angular_velocity, dt):
    """Exact pre-optimization implementation from git HEAD (b3fbce2 physics.py)."""
    omega = np.asarray(angular_velocity, dtype=float)
    speed = float(np.linalg.norm(omega))
    if speed < 1e-10 or dt <= 0:
        return quaternion
    half_angle = speed * dt / 2
    axis = omega / speed * math.sin(half_angle)
    x, y, z, w = quaternion
    dx, dy, dz = axis
    dw = math.cos(half_angle)
    result = np.array([
        dw * x + dx * w + dy * z - dz * y,
        dw * y - dx * z + dy * w + dz * x,
        dw * z + dx * y - dy * x + dz * w,
        dw * w - dx * x - dy * y - dz * z,
    ])
    result /= np.linalg.norm(result)
    return [round(float(value), 9) for value in result]


def _legacy_trajectory(system, quaternions):
    """Exact pre-optimization trajectory loop, retaining its NumPy step above."""
    balls = sorted(system.balls.values(), key=lambda ball: ball.id)
    frames = []
    last_time = 0.0
    emitted = {}
    for index in range(len(balls[0].history_cts)):
        timestamp = float(balls[0].history_cts[index].t)
        frame_balls = []
        for ball in balls:
            current = ball.history_cts[index]
            if index:
                previous = ball.history_cts[index - 1]
                omega = (previous.rvw[2] + current.rvw[2]) / 2
                quaternions[ball.id] = _legacy_quaternion_step(quaternions[ball.id], omega, timestamp - last_time)
            position = [round(float(value), 5) for value in current.rvw[0]]
            quaternion = [round(float(value), 4) for value in quaternions[ball.id]]
            key = (tuple(position), tuple(quaternion), int(current.s))
            if emitted.get(ball.id) != key:
                emitted[ball.id] = key
                frame_balls.append([ball.id, *position, int(current.s), *quaternion])
        frames.append({"t": round(timestamp, 5), "balls": frame_balls})
        last_time = timestamp
    return {"duration": round(float(system.t), 9), "dt": PLAYBACK_DT, "encoding": "delta", "frames": frames}


def _without_orientations_and_trajectory(value):
    if isinstance(value, dict):
        return {key: _without_orientations_and_trajectory(item) for key, item in value.items()
                if key not in ("quaternion", "trajectory", "trajectories")}
    if isinstance(value, list):
        return [_without_orientations_and_trajectory(item) for item in value]
    return value


class TrajectoryMathTests(unittest.TestCase):
    def test_quaternion_step_matches_independent_numpy_reference(self):
        random = np.random.default_rng(20261102)
        for index in range(500):
            quaternion = random.normal(size=4)
            quaternion /= np.linalg.norm(quaternion)
            angular_velocity = random.uniform(-400.0, 400.0, size=3)
            dt = float(random.uniform(1e-6, 0.1))
            before = quaternion.tolist()
            with self.subTest(index=index):
                actual = _quaternion_step(before, angular_velocity, dt)
                expected = _reference_step(before, angular_velocity, dt)
                np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-9)
                self.assertEqual(before, quaternion.tolist(), "Input orientation is immutable")
                self.assertAlmostEqual(sum(value * value for value in actual), 1.0, places=8)

    def test_no_rotation_preserves_orientation_for_zero_small_or_nonpositive_step(self):
        quaternion = [0.182574186, -0.365148372, 0.547722558, 0.730296743]
        cases = [
            ([0.0, 0.0, 0.0], PLAYBACK_DT),
            ([1e-11, -1e-11, 1e-11], PLAYBACK_DT),
            ([4.0, -6.0, 8.0], 0.0),
            ([4.0, -6.0, 8.0], -PLAYBACK_DT),
        ]
        for angular_velocity, dt in cases:
            with self.subTest(angular_velocity=angular_velocity, dt=dt):
                actual = _quaternion_step(quaternion, angular_velocity, dt)
                self.assertIs(actual, quaternion)
                self.assertEqual(actual, _reference_step(quaternion, angular_velocity, dt))

    def test_accumulated_orientation_matches_reference_and_remains_normalized(self):
        actual = expected = [0.0, 0.0, 0.0, 1.0]
        for index in range(600):
            angular_velocity = np.array([
                170.0 * math.sin(index * 0.07),
                120.0 * math.cos(index * 0.03),
                80.0 * math.sin(index * 0.11),
            ])
            dt = PLAYBACK_DT if index < 599 else 0.0037
            actual = _quaternion_step(actual, angular_velocity, dt)
            expected = _reference_step(expected, angular_velocity, dt)
        np.testing.assert_allclose(actual, expected, rtol=0, atol=5e-8)
        self.assertAlmostEqual(sum(value * value for value in actual), 1.0, places=8)

    def test_trajectory_preserves_stationary_and_pocketed_orientations_and_deltas(self):
        timestamps = [0.0, PLAYBACK_DT, 2 * PLAYBACK_DT, 0.057]
        cue_states = [
            _state(timestamps[0], [0.2, 0.3, 0.028575], [30.0, 5.0, 0.0], pt.constants.rolling),
            _state(timestamps[1], [0.21, 0.31, 0.028575], [20.0, 4.0, 2.0], pt.constants.rolling),
            _state(timestamps[2], [0.22, 0.32, 0.028575], [2.0, 1.0, 0.0], pt.constants.rolling),
            _state(timestamps[3], [0.225, 0.325, 0.028575], [0.0, 0.0, 0.0], pt.constants.stationary),
        ]
        balls = {
            "cue": SimpleNamespace(id="cue", history_cts=cue_states),
            "1": SimpleNamespace(id="1", history_cts=[
                _state(t, [0.4, 0.8, 0.028575], [0.0] * 3, pt.constants.stationary)
                for t in timestamps
            ]),
            "9": SimpleNamespace(id="9", history_cts=[
                _state(t, [0.0, 0.0, -0.1], [0.0] * 3, pt.constants.pocketed)
                for t in timestamps
            ]),
        }
        orientations = {
            "cue": [0.0, 0.0, 0.0, 1.0],
            "1": [0.0, 0.6, 0.0, 0.8],
            "9": [0.6, 0.0, 0.0, 0.8],
        }
        expected_orientations = copy.deepcopy(orientations)
        before_histories = {key: [state.rvw.copy() for state in ball.history_cts] for key, ball in balls.items()}
        result = PhysicsEngine._trajectory(SimpleNamespace(balls=balls, t=timestamps[-1]), orientations)

        self.assertEqual(result["encoding"], "delta")
        self.assertEqual(result["dt"], PLAYBACK_DT)
        self.assertEqual(result["duration"], timestamps[-1])
        self.assertEqual(len(result["frames"]), len(timestamps))
        self.assertEqual([entry[0] for entry in result["frames"][0]["balls"]], ["1", "9", "cue"])
        self.assertEqual(orientations["1"], expected_orientations["1"])
        self.assertEqual(orientations["9"], expected_orientations["9"])
        for index, (timestamp, frame) in enumerate(zip(timestamps, result["frames"])):
            self.assertEqual(frame["t"], round(timestamp, 5))
            if index:
                self.assertEqual([entry[0] for entry in frame["balls"]], ["cue"])
                average_omega = np.mean([cue_states[index - 1].rvw[2], cue_states[index].rvw[2]], axis=0)
                expected_orientations["cue"] = _reference_step(
                    expected_orientations["cue"], average_omega, timestamp - timestamps[index - 1],
                )
            cue_entry = next(entry for entry in frame["balls"] if entry[0] == "cue")
            self.assertEqual(cue_entry[1:4], [round(float(value), 5) for value in cue_states[index].rvw[0]])
            self.assertEqual(cue_entry[4], cue_states[index].s)
            self.assertEqual(cue_entry[5:], [round(value, 4) for value in expected_orientations["cue"]])
        np.testing.assert_allclose(orientations["cue"], expected_orientations["cue"], rtol=0, atol=1e-9)
        for key, ball in balls.items():
            for actual, expected in zip(ball.history_cts, before_histories[key]):
                np.testing.assert_array_equal(actual.rvw, expected)

    def test_shared_rvw_stationary_skip_matches_legacy_without_skipping_spin(self):
        timestamps = [0.0, PLAYBACK_DT, 2 * PLAYBACK_DT, 3 * PLAYBACK_DT]
        resting_rvw = np.array([[0.4, 0.8, 0.028575], [0.0] * 3, [0.0] * 3])
        pocketed_rvw = np.array([[0.0, 0.0, -0.1], [0.0] * 3, [0.0] * 3])
        spinning_rvw = np.array([[0.2, 0.3, 0.028575], [0.0] * 3, [0.0, 0.0, 12.0]])
        balls = {}
        for ball_id, rvw, state in (
            ("1", resting_rvw, pt.constants.stationary),
            ("9", pocketed_rvw, pt.constants.pocketed),
            ("cue", spinning_rvw, pt.constants.spinning),
        ):
            balls[ball_id] = SimpleNamespace(id=ball_id, history_cts=[
                SimpleNamespace(t=t, s=state, rvw=rvw) for t in timestamps
            ])
            self.assertIs(balls[ball_id].history_cts[0].rvw, balls[ball_id].history_cts[-1].rvw)
        system = SimpleNamespace(balls=balls, t=timestamps[-1])
        actual_orientation = {"1": [0.0, 0.6, 0.0, 0.8], "9": [0.6, 0.0, 0.0, 0.8], "cue": [0.0, 0.0, 0.0, 1.0]}
        legacy_orientation = copy.deepcopy(actual_orientation)
        actual = PhysicsEngine._trajectory(system, actual_orientation)
        legacy = _legacy_trajectory(system, legacy_orientation)
        self.assertEqual(actual, legacy)
        self.assertEqual(actual_orientation, legacy_orientation)
        self.assertEqual([entry[0] for entry in actual["frames"][0]["balls"]], ["1", "9", "cue"])
        self.assertTrue(all([entry[0] for entry in frame["balls"]] == ["cue"] for frame in actual["frames"][1:]))

    def test_real_shots_match_legacy_authority_and_playback(self):
        variants = [
            (1000, {"V0": 0.2, "phi": 270.0}),
            (1001, {"V0": 3.0}),
            (1002, {"V0": 2.4, "a": 0.3, "b": -0.2}),
        ]
        for seed, shot in variants:
            with self.subTest(seed=seed, shot=shot):
                state = PhysicsEngine.new_match(seed)
                cue = state["system"]["balls"]["cue"]["rvw"][0]
                table = state["snapshot"]["table"]
                shot = {"phi": math.degrees(math.atan2(table["length"] * 0.75 - cue[1], table["width"] * 0.5 - cue[0])), **shot}
                actual = PhysicsEngine.simulate(state, shot)
                with patch.object(PhysicsEngine, "_trajectory", staticmethod(_legacy_trajectory)):
                    legacy = PhysicsEngine.simulate(state, shot)
                self.assertEqual(_without_orientations_and_trajectory(actual), _without_orientations_and_trajectory(legacy))
                for ball_id, ball in actual["state"]["system"]["balls"].items():
                    np.testing.assert_allclose(ball["quaternion"], legacy["state"]["system"]["balls"][ball_id]["quaternion"], rtol=0, atol=1e-7)
                self.assertEqual(len(actual["trajectory"]["frames"]), len(legacy["trajectory"]["frames"]))
                for actual_frame, legacy_frame in zip(actual["trajectory"]["frames"], legacy["trajectory"]["frames"]):
                    self.assertEqual(actual_frame["t"], legacy_frame["t"])
                    self.assertEqual(len(actual_frame["balls"]), len(legacy_frame["balls"]))
                    for actual_ball, legacy_ball in zip(actual_frame["balls"], legacy_frame["balls"]):
                        self.assertEqual(actual_ball[:5], legacy_ball[:5])
                        np.testing.assert_allclose(actual_ball[5:], legacy_ball[5:], rtol=0, atol=1e-4 + 1e-12)


if __name__ == "__main__":
    unittest.main()
