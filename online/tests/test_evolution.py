"""Exact state/history regression for the online-only evolution batching."""
import importlib
import unittest
from unittest.mock import patch

import numpy as np

import pooltool as pt
import pooltool.constants as const
from online.server.detection import OnlineEventDetector
from online.server.evolution import (
    _OnlineSimulationState, _evolve_batch, _record_history, _supports_batch,
    simulate_online,
)
from online.server.physics import PhysicsEngine, _restore_system
from online.tests.test_detection_pairs import recorded_case
from pooltool.events import (
    EventType, null_event, rolling_spinning_transition, spinning_stationary_transition,
)
from pooltool.evolution.engine import SimulationEngine
from pooltool.evolution.event_based.simulate import _SimulationState, simulate
from pooltool.objects.ball.datatypes import BallState
from pooltool.objects.ball.params import BallParams
from pooltool.physics.evolve import evolve_ball_motion
from pooltool.physics.resolve.resolver import default_resolver


def online_engine():
    engine = SimulationEngine(resolver=default_resolver())
    engine.detector = OnlineEventDetector()
    return engine


class EvolutionTests(unittest.TestCase):
    def assert_system_equal(self, actual, expected):
        self.assertEqual(actual.t, expected.t)
        self.assertEqual(len(actual.events), len(expected.events))
        for actual_event, expected_event in zip(actual.events, expected.events):
            self.assertEqual(actual_event.event_type, expected_event.event_type)
            self.assertEqual(actual_event.ids, expected_event.ids)
            self.assertEqual(actual_event.time, expected_event.time)
            for actual_agent, expected_agent in zip(actual_event.agents, expected_event.agents):
                for which in ("initial", "final"):
                    actual_object = getattr(actual_agent, which)
                    expected_object = getattr(expected_agent, which)
                    if isinstance(expected_object, pt.Ball):
                        self.assertEqual(actual_object.state.s, expected_object.state.s)
                        self.assertEqual(actual_object.state.t, expected_object.state.t)
                        np.testing.assert_array_equal(actual_object.state.rvw, expected_object.state.rvw)
                        self.assertEqual(len(actual_object.history), 0)
                        self.assertEqual(len(actual_object.history_cts), 0)
                    else:
                        self.assertEqual(actual_object, expected_object)
        self.assertEqual(list(actual.balls), list(expected.balls))
        for key in actual.balls:
            a, b = actual.balls[key], expected.balls[key]
            self.assertEqual(a.state.s, b.state.s)
            self.assertEqual(a.state.t, b.state.t)
            np.testing.assert_array_equal(a.state.rvw, b.state.rvw)
            for name in ("history", "history_cts"):
                first, second = getattr(a, name), getattr(b, name)
                self.assertEqual(len(first), len(second))
                for before, after in zip(first, second):
                    self.assertEqual(before.s, after.s)
                    self.assertEqual(before.t, after.t)
                    self.assertIs(type(before.t), type(after.t))
                    np.testing.assert_array_equal(before.rvw, after.rvw)
        for key in actual.table.pockets:
            self.assertEqual(actual.table.pockets[key].contains, expected.table.pockets[key].contains)

    def test_batch_kernel_is_exact_for_every_planar_state_and_array_layout(self):
        rng = np.random.default_rng(1407)
        parameters = np.asarray([[.028575, .170097, .2, .0127, .01, 9.81]] * 5)
        states = np.asarray([const.stationary, const.spinning, const.sliding,
                             const.rolling, const.pocketed], dtype=np.int64)
        for step in (0., 1e-12, .0007, .01, .3, 2.0):
            for layout in ("C", "F"):
                rvws = rng.normal(size=(5, 3, 3))
                rvws[:, 0, 2] = .028575
                rvws[:, 1, 2] = 0
                original = [np.array(row, order=layout) for row in rvws]
                before = [row.copy() for row in original]
                actual = _evolve_batch(np.asarray(original), states, parameters, step)
                for index, (source, output) in enumerate(zip(original, actual)):
                    R, m, u_s, u_sp, u_r, g = parameters[index]
                    expected, _ = evolve_ball_motion(states[index], source, R, m, u_s, u_sp, u_r, g, step)
                    np.testing.assert_array_equal(output, expected)
                    np.testing.assert_array_equal(source, before[index])
                    self.assertFalse(np.shares_memory(output, source))
                    for other in actual[index + 1:]:
                        self.assertFalse(np.shares_memory(output, other))

    def test_step_trace_keeps_exact_history_agents_cache_and_array_ownership(self):
        state = PhysicsEngine.new_match(123)
        expected, actual = _restore_system(state), _restore_system(state)
        for shot in (expected, actual):
            shot.strike(V0=3., phi=90., a=.2, b=-.1)
        baseline = _SimulationState(expected, online_engine())
        optimized = _OnlineSimulationState(actual, online_engine())
        baseline.init(); optimized.init()
        while not baseline.done:
            previous = {key: ball.state for key, ball in actual.balls.items()}
            e1, e2 = baseline.step(), optimized.step()
            self.assertEqual(baseline.done, optimized.done)
            self.assert_system_equal(actual, expected)
            if not baseline.done:
                baseline.update_caches(e1); optimized.update_caches(e2)
                self.assertEqual(baseline.collision_cache.times, optimized.collision_cache.times)
                for key, ball in actual.balls.items():
                    self.assertIsNot(ball.state, previous[key])
                    self.assertFalse(np.shares_memory(ball.state.rvw, previous[key].rvw))
        self.assertEqual(baseline.num_events, optimized.num_events)

    def test_recorded_dense_case_and_continuous_history_match_exactly(self):
        fixture, state = recorded_case(PhysicsEngine())
        expected, actual = _restore_system(state), _restore_system(state)
        for shot in (expected, actual): shot.strike(**fixture["shot"])
        simulate(expected, engine=online_engine(), inplace=True, continuous=True, dt=1/60)
        simulate_online(actual, engine=online_engine(), inplace=True, continuous=True, dt=1/60)
        self.assert_system_equal(actual, expected)
        self.assertEqual(len(actual.events), fixture["observedEvents"])

    def test_evolution_keeps_old_motion_label_until_transition_resolution(self):
        state = PhysicsEngine.new_match(9)
        expected, actual = _restore_system(state), _restore_system(state)
        for shot in (expected, actual):
            shot.balls["cue"].state = BallState(
                np.asarray([[.4, .5, .028575], [.2, 0., 0.], [0., 0., 0.]]),
                const.sliding,
            )
        before = actual.balls["cue"].state
        _SimulationState.evolve(expected, 2.)
        optimized = _OnlineSimulationState(actual, online_engine())
        optimized.evolve(actual, 2.)
        self.assertEqual(actual.balls["cue"].state.s, const.sliding)
        self.assertIsNot(actual.balls["cue"].state, before)
        self.assertFalse(np.shares_memory(actual.balls["cue"].state.rvw, before.rvw))
        self.assert_system_equal(actual, expected)

    def test_simultaneous_zero_time_events_keep_duplicate_history_entries(self):
        class SequenceDetector:
            def __init__(self, ball):
                self.events = iter([
                    rolling_spinning_transition(ball, 0.),
                    spinning_stationary_transition(ball, 0.), null_event(np.inf),
                ])
            def get_next_event(self, *args, **kwargs): return next(self.events)
        source = pt.System.example()
        source.balls["cue"].state = BallState(source.balls["cue"].state.rvw.copy(), const.rolling)
        source.balls["cue"].state.rvw[1:] = 0
        expected, actual = source.copy(), source.copy()
        first, second = online_engine(), online_engine()
        first.detector = SequenceDetector(expected.balls["cue"])
        second.detector = SequenceDetector(actual.balls["cue"])
        baseline = _SimulationState(expected, first)
        optimized = _OnlineSimulationState(actual, second)
        baseline.init(); optimized.init()
        while not baseline.done:
            e1, e2 = baseline.step(), optimized.step()
            self.assertEqual(baseline.done, optimized.done)
            self.assert_system_equal(actual, expected)
            if not baseline.done:
                baseline.update_caches(e1); optimized.update_caches(e2)
        self.assertEqual(len(actual.balls["cue"].history), 4)

    def test_limits_include_filter_and_copy_semantics_match_upstream(self):
        source = pt.System.example()
        source.strike(V0=2., phi=95.)
        for options in ({"max_events":1}, {"t_final":.001},
                        {"include":{EventType.STICK_BALL},"max_events":2},
                        {"max_events":1,"t_final":.001}):
            with self.subTest(options=options):
                expected = simulate(source, engine=online_engine(), **options)
                actual = simulate_online(source, engine=online_engine(), **options)
                self.assert_system_equal(actual, expected)
                self.assertIsNot(actual, source)
                self.assertEqual(len(source.events), 0)
        self.assertIs(simulate_online(source, engine=online_engine(), inplace=True), source)

    def test_history_writer_retains_timestamp_conversion_and_assertion(self):
        shot = pt.System.example()
        shot.reset_history()
        _record_history(shot, null_event(np.float64(.3)))
        for ball in shot.balls.values(): self.assertIs(type(ball.state.t), float)
        # The historical last state and current state can legitimately alias in
        # upstream. A new state is required to exercise the chronology assertion.
        for ball in shot.balls.values(): ball.state = ball.state.copy()
        with self.assertRaises(AssertionError): _record_history(shot, null_event(.2))

    def test_custom_three_dimensional_and_nonstandard_states_use_reference(self):
        module = importlib.import_module("online.server.evolution")
        shot = pt.System.example()
        stock = SimulationEngine(resolver=default_resolver())
        self.assertFalse(_supports_batch(shot, stock))
        with patch.object(module, "simulate", return_value=shot) as fallback:
            self.assertIs(simulate_online(shot, engine=stock), shot)
            fallback.assert_called_once()
        engine = online_engine()
        self.assertTrue(_supports_batch(shot, engine))
        engine.is_3d = True
        self.assertFalse(_supports_batch(shot, engine))
        engine.is_3d = False
        shot.balls["cue"].params = BallParams(R=np.float32(.028575))
        self.assertFalse(_supports_batch(shot, engine))
        shot.balls["cue"].params = BallParams()
        shot.balls["cue"].state = BallState(shot.balls["cue"].state.rvw, const.airborne)
        self.assertFalse(_supports_batch(shot, engine))


if __name__ == "__main__": unittest.main()
