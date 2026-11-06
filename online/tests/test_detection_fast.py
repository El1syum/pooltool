"""Exact regression for the private multi-row detector workspace.

The numerical oracle is the unchanged per-ball batch path. Physical event/cache
comparisons use actual Pooltool systems; patches are restricted to observing
workspace lifetime or injecting an explicit failure into the batching boundary.
"""
from types import SimpleNamespace
from unittest.mock import patch

import attrs
import numpy as np
import pytest

import pooltool.constants as const
from online.server import detection
from online.server.detection import OnlineEventDetector
from online.server.ordered_cache import OnlineCollisionCache
from online.server.physics import PhysicsEngine, _restore_system
from pooltool.events import EventType, null_event
from pooltool.evolution.engine import SimulationEngine
from pooltool.evolution.event_based.cache import CollisionCache
from pooltool.evolution.event_based.detect import EventDetector
from pooltool.evolution.event_based.simulate import _SimulationState
from pooltool.objects.ball.datatypes import BallState
from pooltool.physics.resolve.resolver import default_resolver


@pytest.fixture
def system():
    return _restore_system(PhysicsEngine.new_match(87))


def _geometry(system, kind):
    if kind == 0:
        return np.asarray([[obj.lx, obj.ly, obj.l0, *obj.p1, *obj.p2, obj.direction]
                           for obj in system.table.cushion_segments.linear.values()])
    objects = (system.table.cushion_segments.circular if kind == 1 else system.table.pockets)
    return np.asarray([[obj.a, obj.b, obj.radius] for obj in objects.values()])


def _event_key(event):
    return event.event_type, event.ids, event.time


def _assert_cache_equal(actual, expected):
    assert list(actual.times) == list(expected.times)
    for kind in expected.times:
        assert list(actual.times[kind]) == list(expected.times[kind])
        np.testing.assert_array_equal(
            np.asarray(list(actual.times[kind].values())),
            np.asarray(list(expected.times[kind].values())),
        )


def _moving(system):
    system.t = .125
    for ball in system.balls.values():
        ball.state.t = system.t
    radius = system.balls["cue"].params.R
    system.balls["cue"].state = BallState(
        np.asarray([[.45, .35, radius], [1.1, .8, 0.], [2., -1., 18.]]), const.sliding, system.t)
    system.balls["1"].state = BallState(
        np.asarray([[.3, .8, radius], [.25, -.7, 0.], [.7 / radius, .25 / radius, 5.]]), const.rolling, system.t)
    system.balls["2"].state = BallState(
        np.asarray([[.7, 1., radius], [0., 0., 0.], [0., 0., 20.]]), const.spinning, system.t)
    return system


def _paired(detector, shot, private, plain):
    actual = detector.get_next_event(shot, collision_cache=private)
    expected = detector.get_next_event(shot, collision_cache=plain)
    assert _event_key(actual) == _event_key(expected)
    _assert_cache_equal(private, plain)
    return actual


def test_multirow_kernel_matches_all_scalar_rows_with_mixed_parameters_and_layouts(system):
    rng = np.random.default_rng(2026110625)
    states = np.asarray([const.stationary, const.spinning, const.sliding,
                         const.rolling, const.pocketed, const.airborne], dtype=np.int64)
    batches = [detection._linear_batch, detection._circular_batch, detection._pocket_batch]
    comparisons = 0
    for base_radius in (.021, .028575, .031, .06):
        params = np.asarray([[base_radius * (1 + index * .01), .11 + index * .025,
                              .18 + index * .01, .007 + index * .002, 9.81 - index * .03]
                             for index in range(len(states))])
        rvws = rng.uniform(-2, 2, (len(states), 3, 3))
        rvws[:, 0, 0] = rng.uniform(.1, .9, len(states))
        rvws[:, 0, 1] = rng.uniform(.1, 1.8, len(states))
        rvws[:, 0, 2] = params[:, 0]
        rvws[:, 1, 2] = 0
        rvws[:, 2] *= 60
        rvws[-1, 0, 2] += .3; rvws[-1, 1, 2] = -.2
        for layout in ("C", "F"):
            source = np.array(rvws, order=layout)
            for kind, scalar_batch in enumerate(batches):
                original = _geometry(system, kind)
                changed = original.copy()
                if kind == 0:
                    changed[0, -1] = .5  # Original both-sides plane branch.
                else:
                    changed[:, 0] += .005; changed[:, 2] *= .95
                variants = [original, original[::2].copy(), original[::-1].copy(), changed,
                            np.empty((0, original.shape[1]))]
                for geometry in variants:
                    for indices in (np.arange(len(states)), np.asarray([4, 0, 4, 2]), np.empty(0, dtype=np.int64)):
                        before = [array.copy() for array in (source, states, params, indices, geometry)]
                        actual = detection._table_rows(source, states, params, indices, geometry, kind)
                        expected = []
                        for index in indices:
                            radius, mass, sliding, rolling, gravity = params[index]
                            mu = sliding if states[index] == const.sliding else rolling
                            expected.append(scalar_batch(source[index], states[index], mu, mass, gravity, radius, geometry))
                        expected = np.asarray(expected).reshape((len(indices), len(geometry)))
                        np.testing.assert_array_equal(actual, expected)
                        assert actual.shape == (len(indices), len(geometry))
                        for array, old in zip((source, states, params, indices, geometry), before):
                            np.testing.assert_array_equal(array, old)
                        comparisons += actual.size
    assert comparisons >= 10_000, "All states/radii/row-order/geometry branches must actually be covered"


def test_private_workspace_and_plain_cache_have_identical_real_event_sequence_and_partial_refills(system):
    def engine():
        value = SimulationEngine(resolver=default_resolver()); value.detector = OnlineEventDetector()
        return value
    first, second = system.copy(), system.copy()
    for shot in (first, second): shot.strike(V0=4., phi=95., a=.2, b=.3)
    baseline, actual = _SimulationState(first, engine()), _SimulationState(second, engine())
    actual.collision_cache = OnlineCollisionCache.create()
    baseline.init(); actual.init()
    refills = 0
    for step in range(80):
        old, new = baseline.step(), actual.step()
        assert _event_key(new) == _event_key(old)
        assert actual.done == baseline.done
        _assert_cache_equal(actual.collision_cache, baseline.collision_cache)
        assert getattr(actual.collision_cache, "_online_workspace", None) is None
        for ball_id in first.balls:
            np.testing.assert_array_equal(second.balls[ball_id].state.rvw, first.balls[ball_id].state.rvw)
            assert second.balls[ball_id].state.s == first.balls[ball_id].state.s
        if baseline.done:
            break
        baseline.update_caches(old); actual.update_caches(new)
        if step in (2, 11, 30):
            refills += 1
            for kind, mapping in baseline.collision_cache.times.items():
                for key in list(mapping)[::7]:
                    mapping.pop(key)
                    actual.collision_cache.times[kind].pop(key)
    assert refills >= 2, "The real trace must exercise repeated partial-pop/refill paths"


def test_external_dictionary_and_reversed_layout_replacements_preserve_values_and_order(system):
    shot = _moving(system); detector = OnlineEventDetector()
    private, plain = OnlineCollisionCache.create(), CollisionCache.create()
    _paired(detector, shot, private, plain)
    for kind, values in list(plain.times.items()):
        replacement = dict(reversed(list(values.items())[::3]))
        private.times[kind] = replacement.copy(); plain.times[kind] = replacement.copy()
    shot.balls = dict(reversed(list(shot.balls.items())))
    objects = shot.table.cushion_segments.linear
    entries = list(objects.items()); objects.clear(); objects.update(reversed(entries))
    _paired(detector, shot, private, plain)
    event = SimpleNamespace(event_type=EventType.BALL_BALL, ids=("cue", "1"))
    private.invalidate(event); plain.invalidate(event)
    _paired(detector, shot, private, plain)


def test_frozen_geometry_replacements_refresh_the_private_workspace_table_batches(system):
    shot = _moving(system); detector = OnlineEventDetector()
    private, plain = OnlineCollisionCache.create(), CollisionCache.create()
    _paired(detector, shot, private, plain)
    replacements = [
        (EventType.BALL_LINEAR_CUSHION, shot.table.cushion_segments.linear, "linear"),
        (EventType.BALL_CIRCULAR_CUSHION, shot.table.cushion_segments.circular, "circular"),
        (EventType.BALL_POCKET, shot.table.pockets, "pocket"),
    ]
    for kind, objects, shape in replacements:
        key = next(iter(objects)); old = objects[key]
        objects[key] = (attrs.evolve(old, p1=old.p1 + [.003, 0., 0.], p2=old.p2 + [.003, 0., 0.])
                        if shape == "linear" else attrs.evolve(old, center=old.center + [.003, 0., 0.], radius=old.radius * .98))
        private.times[kind].clear(); plain.times[kind].clear()
        _paired(detector, shot, private, plain)
        refs = private.times[kind]._shape_refs
        assert any(value is objects[key] for value in refs)
        assert all(value is not old for value in refs)
        np.testing.assert_array_equal(private.times[kind]._shape_geometry,
                                      _geometry(shot, {"linear": 0, "circular": 1, "pocket": 2}[shape]))


def test_nested_detection_restores_the_outer_workspace_and_then_previous_owner(system):
    shot = _moving(system); detector = OnlineEventDetector(); cache = OnlineCollisionCache.create()
    previous = object(); cache._online_workspace = previous
    original = detection._table_rows
    seen = []; nesting = False
    def probe(*args):
        nonlocal nesting
        current = cache._online_workspace
        seen.append(current)
        if not nesting:
            nesting = True
            detector.get_next_event(shot, collision_cache=cache)
            assert cache._online_workspace is current
        return original(*args)
    with patch.object(detection, "_table_rows", side_effect=probe):
        detector.get_next_event(shot, collision_cache=cache)
    assert len(seen) >= 2 and seen[0] is not seen[1]
    assert cache._online_workspace is previous


def test_raising_after_one_table_batch_restores_workspace_and_preserves_successful_partial_cache(system):
    shot = _moving(system); detector = OnlineEventDetector(); cache = OnlineCollisionCache.create()
    previous = object(); cache._online_workspace = previous
    original = detection._table_rows
    def fail_after_linear(*args):
        if args[-1] == 1:
            raise RuntimeError("explicit mid-detector failure")
        return original(*args)
    with patch.object(detection, "_table_rows", side_effect=fail_after_linear), pytest.raises(RuntimeError, match="mid-detector"):
        detector.get_next_event(shot, collision_cache=cache)
    assert cache._online_workspace is previous
    successful = list(cache.times[EventType.BALL_LINEAR_CUSHION].items())
    assert successful
    cache._online_workspace = None
    _paired(detector, shot, cache, CollisionCache.create())
    assert list(cache.times[EventType.BALL_LINEAR_CUSHION].items()) == successful


def test_zero_dt_state_and_frozen_parameter_replacement_get_fresh_arrays_and_results(system):
    shot = _moving(system); detector = OnlineEventDetector()
    private, plain = OnlineCollisionCache.create(), CollisionCache.create()
    captured = []; original = detection._table_rows
    def observe(*args):
        if args[-1] == 0:
            captured.append((private._online_workspace, args[0].copy(), args[1].copy(), args[2].copy()))
        return original(*args)
    with patch.object(detection, "_table_rows", side_effect=observe):
        # Only observe the private call; the plain cache follows the scalar path.
        _paired(detector, shot, private, plain)
        old_params = shot.balls["cue"].params
        shot.balls["cue"].params = attrs.evolve(old_params, u_r=old_params.u_r * 1.5, m=old_params.m * 1.1)
        shot.balls["cue"].state.rvw[1] *= -1
        shot.balls["cue"].state.s = const.rolling
        event = SimpleNamespace(event_type=EventType.BALL_BALL, ids=("cue", "1"))
        private.invalidate(event); plain.invalidate(event)
        _paired(detector, shot, private, plain)
    assert shot.t == .125  # A timestamp-only memo would incorrectly reuse arrays.
    assert len(captured) >= 2
    first, second = captured[0], captured[-1]
    index = private._online_indices["cue"]
    assert first[0] is not second[0]
    assert first[2][index] == const.sliding and second[2][index] == const.rolling
    np.testing.assert_array_equal(first[1][index, 1], -second[1][index, 1])
    assert first[3][index, 1] != second[3][index, 1]
    assert first[3][index, 3] != second[3][index, 3]
    assert any(value is shot.balls["cue"].params for value in private._online_param_refs)
    assert all(value is not old_params for value in private._online_param_refs)


def test_ball_object_replacement_keeps_live_state_not_a_cached_ball_reference(system):
    shot = _moving(system); detector = OnlineEventDetector()
    private, plain = OnlineCollisionCache.create(), CollisionCache.create()
    _paired(detector, shot, private, plain)
    old = shot.balls["cue"]
    replacement = old.copy()
    replacement.state.rvw[1] *= -.5
    shot.balls["cue"] = replacement
    event = SimpleNamespace(event_type=EventType.BALL_BALL, ids=("cue", "1"))
    private.invalidate(event); plain.invalidate(event)
    _paired(detector, shot, private, plain)


def test_workspace_is_not_installed_for_public_or_three_dimensional_callers(system):
    marker = null_event(np.inf)
    for detector, cache in [(OnlineEventDetector(), CollisionCache.create()),
                            (OnlineEventDetector(is_3d=True), OnlineCollisionCache.create())]:
        previous = object()
        if isinstance(cache, OnlineCollisionCache):
            cache._online_workspace = previous
        with patch.object(detection, "_prepare_workspace", side_effect=AssertionError("unexpected private workspace")), patch.object(EventDetector, "get_next_event", return_value=marker) as fallback:
            assert detector.get_next_event(system, collision_cache=cache) is marker
            fallback.assert_called_once()
        if isinstance(cache, OnlineCollisionCache):
            assert cache._online_workspace is previous
        else:
            assert not hasattr(cache, "_online_workspace")
