"""Pointwise and cache-lifecycle oracles for exact web-only detector batching."""

from itertools import combinations
from unittest.mock import patch

import attrs
import numpy as np
import pytest

import pooltool.constants as const
import pooltool.ptmath as ptmath
from online.server.detection import (
    OnlineEventDetector, _ball_batch, _circular_batch, _linear_batch,
    _next_ball_event, _next_table_event, _pocket_batch,
)
from online.server.physics import PhysicsEngine, _restore_system
from online.tests import reference_detection
from pooltool.events import EventType
from pooltool.evolution.event_based.cache import CollisionCache
from pooltool.evolution.event_based.detect import EventDetector
from pooltool.evolution.event_based.detect.ball_ball import ball_ball_collision_time_2d
from pooltool.evolution.event_based.detect.ball_cushion import (
    ball_vertical_cylinder_collision_time, ball_vertical_plane_collision_time,
)
from pooltool.evolution.event_based.detect.ball_pocket import ball_pocket_collision_time


@pytest.fixture(scope="module")
def system():
    engine = PhysicsEngine()
    engine.warmup()
    return _restore_system(engine.new_match(seed=1))


def test_36000_table_kernel_values_exactly_match_original_scalar_operations(system):
    linear = list(system.table.cushion_segments.linear.values())
    circular = list(system.table.cushion_segments.circular.values())
    pockets = list(system.table.pockets.values())
    line_geometry = np.asarray([[o.lx, o.ly, o.l0, *o.p1, *o.p2, o.direction] for o in linear])
    circle_geometry = np.asarray([[o.a, o.b, o.radius] for o in circular])
    pocket_geometry = np.asarray([[o.a, o.b, o.radius] for o in pockets])
    rng = np.random.default_rng(324677)
    states = (const.sliding, const.rolling, const.stationary, const.spinning, const.pocketed, const.airborne)
    for index in range(1000):
        state = states[index % len(states)]
        rvw = np.asarray([rng.uniform(0, 1.9, 3), rng.uniform(-4, 4, 3), rng.uniform(-120, 120, 3)])
        radius, mass, gravity = .028575, .170097, 9.81
        rvw[0, 2], rvw[1, 2] = radius, 0
        if state == const.airborne:
            rvw[0, 2] += .4
            rvw[1, 2] = rng.uniform(-1, 2)
        mu = .2 if state == const.sliding else .01
        actual = _linear_batch(rvw, state, mu, mass, gravity, radius, line_geometry)
        # Original 2D detector explicitly skips airborne cushions; the scalar
        # plane/cylinder APIs document that they do not support this state.
        expected = np.full(len(linear), np.inf) if state == const.airborne else np.asarray([
            ball_vertical_plane_collision_time(rvw, state, o.lx, o.ly, o.l0, o.p1, o.p2, o.direction, mu, mass, gravity, radius)
            for o in linear
        ])
        assert np.array_equal(actual, expected, equal_nan=True), ("linear", index)
        actual = _circular_batch(rvw, state, mu, mass, gravity, radius, circle_geometry)
        expected = np.full(len(circular), np.inf) if state == const.airborne else np.asarray([
            ball_vertical_cylinder_collision_time(rvw, state, o.a, o.b, o.radius, mu, mass, gravity, radius)
            for o in circular
        ])
        assert np.array_equal(actual, expected, equal_nan=True), ("circular", index)
        actual = _pocket_batch(rvw, state, mu, mass, gravity, radius, pocket_geometry)
        expected = np.asarray([
            ball_pocket_collision_time(rvw, state, o.a, o.b, o.radius, mu, mass, gravity, radius)
            for o in pockets
        ])
        assert np.array_equal(actual, expected, equal_nan=True), ("pocket", index)


def test_24000_ball_pair_values_exactly_match_scalar_including_heterogeneous_radius():
    rng = np.random.default_rng(84671)
    pairs = np.asarray(list(combinations(range(16), 2)))
    for index in range(200):
        rvws = rng.uniform(-2, 2, (16, 3, 3))
        rvws[:, 0, 2], rvws[:, 1, 2] = .028575, 0
        states = rng.integers(0, 6, 16)
        params = np.tile([.028575, .170097, .2, .01, 9.81], (16, 1))
        if index % 2:
            params[4, 0] = .031
        actual = _ball_batch(rvws, states, params, pairs)
        expected = []
        for first, second in pairs:
            s1, s2 = states[first], states[second]
            p1, p2 = params[first], params[second]
            if s1 == const.pocketed or s2 == const.pocketed or (s1 in const.nontranslating and s2 in const.nontranslating):
                value = np.inf
            elif ptmath.is_overlapping(rvws[first], rvws[second], p1[0], p2[0]):
                value = 0.
            else:
                value = ball_ball_collision_time_2d(
                    rvws[first], rvws[second], s1, s2,
                    p1[2] if s1 == const.sliding else p1[3],
                    p2[2] if s2 == const.sliding else p2[3],
                    p1[1], p2[1], p1[4], p2[4], p1[0],
                )
            expected.append(value)
        assert np.array_equal(actual, np.asarray(expected), equal_nan=True), index


def test_nonintegral_plane_direction_retains_original_both_sides_branch(system):
    obj = next(iter(system.table.cushion_segments.linear.values()))
    geometry = np.asarray([[obj.lx, obj.ly, obj.l0, *obj.p1, *obj.p2, .5]])
    rvw = np.asarray([[.5, 1., .028575], [.2, -.7, 0.], [0., 0., 0.]])
    expected = ball_vertical_plane_collision_time(
        rvw, const.sliding, obj.lx, obj.ly, obj.l0, obj.p1, obj.p2, .5,
        .2, .170097, 9.81, .028575,
    )
    actual = _linear_batch(rvw, const.sliding, .2, .170097, 9.81, .028575, geometry)[0]
    assert actual == expected


def _event_key(event):
    return event.event_type, event.ids, event.time


def test_partial_cached_rows_and_component_replacement_retain_values_and_tie_order(system):
    system = system.copy()
    cue = system.balls["cue"]
    cue.state.s = const.sliding
    cue.state.rvw[1] = [1, .4, 0]
    cue.state.rvw[2] = [1, 2, 3]
    system.t = .25
    objects = system.table.cushion_segments.linear
    keys = [(ball, cushion) for ball in system.balls for cushion in objects]
    prefilled = {key: .5 + index for index, key in enumerate(keys[::3])}
    fast = CollisionCache(times={EventType.BALL_LINEAR_CUSHION: prefilled.copy()})
    old = CollisionCache(times={EventType.BALL_LINEAR_CUSHION: prefilled.copy()})
    actual = _next_table_event(system, fast, "linear")
    expected = reference_detection.get_next_ball_linear_cushion_event(system, old)
    assert _event_key(actual) == _event_key(expected)
    assert list(fast.times[EventType.BALL_LINEAR_CUSHION].items()) == list(old.times[EventType.BALL_LINEAR_CUSHION].items())
    first = next(iter(objects))
    old_component = objects[first]
    objects[first] = attrs.evolve(old_component, p1=old_component.p1 + [.01, 0, 0], p2=old_component.p2 + [.01, 0, 0])
    fast.times[EventType.BALL_LINEAR_CUSHION].clear()
    old.times[EventType.BALL_LINEAR_CUSHION].clear()
    actual = _next_table_event(system, fast, "linear")
    expected = reference_detection.get_next_ball_linear_cushion_event(system, old)
    assert _event_key(actual) == _event_key(expected)
    cache = fast.times[EventType.BALL_LINEAR_CUSHION]
    assert any(obj is objects[first] for obj in cache._shape_refs)
    assert all(obj is not old_component for obj in cache._shape_refs)


def test_frozen_parameter_replacement_refreshes_ball_batch(system):
    system = system.copy()
    cue = system.balls["cue"]
    cue.state.s = const.sliding
    cue.state.rvw[1] = [1, .4, 0]
    fast, old = CollisionCache(), CollisionCache()
    _next_ball_event(system, fast)
    previous = cue.params
    cue.params = attrs.evolve(cue.params, u_r=cue.params.u_r * 1.5)
    fast.times[EventType.BALL_BALL].clear()
    actual = _next_ball_event(system, fast)
    expected = reference_detection.get_next_ball_ball_event(system, old, is_3d=False)
    assert _event_key(actual) == _event_key(expected)
    refs = fast.times[EventType.BALL_BALL]._ball_params_refs
    assert any(obj is cue.params for obj in refs)
    assert all(obj is not previous for obj in refs)


def test_three_dimensional_detector_delegates_all_paths_to_original_engine():
    detector = OnlineEventDetector(is_3d=True)
    for name in ("_ball_ball_event", "_linear_cushion_event", "_circular_cushion_event", "_pocket_event"):
        marker = object()
        with patch.object(EventDetector, name, return_value=marker) as original:
            assert getattr(detector, name)("shot", "cache") is marker
            original.assert_called_once_with("shot", "cache")
