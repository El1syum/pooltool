"""Conservative pruning properties against the actual legacy scalar root filter.

These tests do not replace full platform-specific golden comparisons. They pin
known complex-root counterexamples, prove sampled interval containment and
compare complete dense event/history traces with the unpruned simulator.
"""
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import pytest

import pooltool.constants as const
from online.server import broadphase, detection, evolution
from online.server.detection import OnlineEventDetector, _coefficients, _table_rows
from online.server.evolution import _OnlineSimulationState, simulate_online
from online.server.ordered_cache import OnlineCollisionCache
from online.server.physics import PhysicsEngine, _restore_system
from online.tests.latency_corpus import build_cases
from pooltool.events import EventType, null_event
from pooltool.evolution.engine import SimulationEngine
from pooltool.evolution.event_based.cache import TransitionCache
from pooltool.evolution.event_based.config import INCLUDED_EVENTS
from pooltool.evolution.event_based.simulate import _SimulationState, simulate
from pooltool.physics.resolve.resolver import default_resolver
from pooltool.physics.utils import get_roll_time, get_slide_time


PARAMETERS = np.asarray([.028575, .170097, .2, .01, 9.81])


def _rolling(x=.5, y=.7, vx=1., vy=0.):
    radius = PARAMETERS[0]
    return np.asarray([[x, y, radius], [vx, vy, 0.], [-vy / radius, vx / radius, 0.]])


def _engine():
    engine = SimulationEngine(resolver=default_resolver())
    engine.detector = OnlineEventDetector()
    return engine


def _geometry(system, kind):
    if kind == 0:
        return np.asarray([[obj.lx, obj.ly, obj.l0, *obj.p1, *obj.p2, obj.direction]
                           for obj in system.table.cushion_segments.linear.values()])
    objects = system.table.cushion_segments.circular if kind == 1 else system.table.pockets
    return np.asarray([[obj.a, obj.b, obj.radius] for obj in objects.values()])


def _compare_rows(rvws, states, params, geometry, kind, horizons):
    indices = np.arange(len(states))
    before = _table_rows(rvws, states, params, indices, geometry, kind)
    after = broadphase._table_rows_pruned(rvws, states, params, indices, geometry, kind, horizons)
    must_keep = np.isfinite(before) & (before <= horizons[:, None])
    np.testing.assert_array_equal(after[must_keep], before[must_keep])
    # Pruning is allowed only to discard an unused future value, never invent
    # or change a surviving root. Infinite old values must remain infinite too.
    assert np.all((after == before) | (np.isinf(after) & np.isfinite(before) & ~must_keep))
    return before, after, int(np.count_nonzero(must_keep))


def test_reported_near_complex_root_outside_the_real_circle_is_never_pruned():
    # This has no exact real path/circle intersection. The legacy root filter
    # nevertheless accepts its small imaginary component; the optimization must
    # retain that actual numerical result rather than "correct" the physics.
    rvw = _rolling(x=-.004, y=.0645000001, vx=8.)
    coeff = _coefficients(rvw, const.rolling, .01, 9.81, .028575)
    np.testing.assert_allclose(coeff, [-.04905, 0., 8., 0., -.004, .0645000001], rtol=0, atol=1e-16)
    geometry = np.asarray([[0., 0., .0645]])
    rvws, states, params = rvw[None, ...], np.asarray([const.rolling]), PARAMETERS[None, ...]
    old, new, kept = _compare_rows(rvws, states, params, geometry, 2, np.asarray([.001]))
    assert kept == 1 and 0 < old[0, 0] < .001
    np.testing.assert_array_equal(new, old)
    # The same input with a long real transition horizon must use the exact
    # domain fallback, not silently constrain a trajectory to one second.
    old, new, _ = _compare_rows(rvws, states, params, geometry, 2, np.asarray([81.55]))
    np.testing.assert_array_equal(new, old)


@pytest.mark.parametrize("rvw,horizon,eligible", [
    (np.asarray([[.0870017227877817, .0285750001, .028575],
                 [8., 0., 0.], [0., 8. / .028575, 0.]]), 81.54943934760448, False),
    (np.asarray([[.0909567227877817, .02857500000001, .028575],
                 [.09, 0., 0.], [0., 3.149606299212598, 0.]]), .9174311926605504, True),
])
def test_actual_stock_jaw_near_complex_root_is_preserved_inside_and_outside_pruning_domain(rvw, horizon, eligible):
    # Exact geometry of stock jaw 1t. The slow case is inside the H<=1 domain
    # and misses the real circle by 1e-14 m, yet the stock root filter accepts it.
    geometry = np.asarray([[.09100172278778171, -.02095, .02095]])
    assert broadphase._geometry_supported(geometry, 1)
    assert broadphase._ball_supported(rvw, PARAMETERS, horizon) == eligible
    before, after, kept = _compare_rows(rvw[None, ...], np.asarray([const.rolling]),
                                       PARAMETERS[None, ...], geometry, 1, np.asarray([horizon]))
    assert kept == 1 and 0 < before[0, 0] < .001
    np.testing.assert_array_equal(after, before)
    if eligible:
        box = broadphase._motion_box(rvw, const.rolling, PARAMETERS, horizon)
        assert not broadphase._target_disjoint(box, geometry[0], 1, PARAMETERS[0])


def test_near_tangencies_across_absolute_relative_real_root_cutoff_are_retained():
    geometry = np.asarray([[0., 0., .0645]])
    accepted = 0
    for closest in (1e-7, 1e-6, 1e-5, .0005, .000999999, .001, .001000001, .01, .1):
        for gap in (0., np.spacing(.0645), 1e-16, 1e-14, 1e-12, 1e-10, 1e-8, 1e-6, .0001, .01):
            # x(t) reaches zero at `closest`, including a normal rolling
            # deceleration. Values just outside the circle stress complex roots.
            x = .04905 * closest * closest - 8. * closest
            rvw = _rolling(x=x, y=.0645 + gap, vx=8.)
            horizon = min(1., closest * 1.5 + 1e-5)
            _, _, kept = _compare_rows(rvw[None, ...], np.asarray([const.rolling]),
                                       PARAMETERS[None, ...], geometry, 2, np.asarray([horizon]))
            accepted += kept
    assert accepted >= 20, "Near-real roots must actually exercise the stock root-filter acceptance"


def test_quadratic_interval_contains_endpoint_turning_point_and_random_samples():
    # Endpoint-only bounds would miss x(.5)=1 despite x(0)=x(1)=0.
    low, high = broadphase._axis_bounds(-4., 4., 0., 1., np.nextafter(1., np.inf))
    assert low <= 0. and high >= 1.
    rng = np.random.default_rng(20351106)
    for _ in range(500):
        a, b, c = rng.uniform(-16, 16), rng.uniform(-32, 32), rng.uniform(-4, 4)
        horizon = rng.uniform(0, 1)
        low, high = broadphase._axis_bounds(a, b, c, horizon, np.nextafter(horizon * horizon, np.inf))
        times = np.linspace(0, horizon, 129)
        positions = a * times * times + b * times + c
        assert np.all(positions >= low) and np.all(positions <= high)
        if a:
            vertex = -b / (2 * a)
            if 0 <= vertex <= horizon:
                point = a * vertex * vertex + b * vertex + c
                assert low <= point <= high


def test_touching_horizon_segment_endpoint_circle_and_one_ulp_boundary_are_not_pruned():
    rvw = _rolling(); horizon = .1
    coeff = _coefficients(rvw, const.rolling, .01, 9.81, .028575)
    endpoint = coeff[0] * horizon * horizon + coeff[2] * horizon + coeff[4]
    for direction in (-np.inf, np.inf):
        endpoint_variant = np.nextafter(endpoint, direction)
        # At a linear segment endpoint, score==0 is part of the accepted range.
        line_x = endpoint_variant + PARAMETERS[0]
        line = np.asarray([[1., 0., -line_x, line_x, .7, .036576, line_x, 1.5, .036576, 0.]])
        circle = np.asarray([[endpoint_variant + .03 + PARAMETERS[0], .7, .03]])
        pocket = np.asarray([[endpoint_variant + .0645, .7, .0645]])
        for kind, geometry in enumerate((line, circle, pocket)):
            before = _table_rows(rvw[None, ...], np.asarray([const.rolling]), PARAMETERS[None, ...], np.asarray([0]), geometry, kind)
            after = broadphase._table_rows_pruned(rvw[None, ...], np.asarray([const.rolling]), PARAMETERS[None, ...], np.asarray([0]), geometry, kind, np.asarray([horizon]))
            assert np.isfinite(before[0, 0]), (kind, before)
            np.testing.assert_array_equal(after, before)
    point_box = broadphase._motion_box(rvw, const.rolling, PARAMETERS, 0.)
    corner = np.asarray([.5 + .03 + PARAMETERS[0], .7 + .03 + PARAMETERS[0], .03])
    # Square AABB expansion can retain a corner that the actual circles miss;
    # conservative false positives are allowed, touching edges cannot be lost.
    assert not broadphase._target_disjoint(point_box, corner, 1, PARAMETERS[0])


def test_known_far_future_root_is_rejected_without_changing_retained_roots():
    rvw = _rolling(x=0., y=0., vx=1.)
    for kind, geometry in (
        (0, np.asarray([[1., 0., -.35, .35, -.5, .036576, .35, .5, .036576, 0.]])),
        (1, np.asarray([[.35, 0., .02]])),
        (2, np.asarray([[.35, 0., .0645]])),
    ):
        old, new, kept = _compare_rows(rvw[None, ...], np.asarray([const.rolling]),
                                      PARAMETERS[None, ...], geometry, kind, np.asarray([.1]))
        assert np.isfinite(old[0, 0]) and old[0, 0] > .1
        assert kept == 0 and np.isinf(new[0, 0])


def test_nonfinite_extreme_nonplanar_and_unsupported_geometry_disable_pruning():
    rvw = _rolling()
    for horizon in (np.nan, np.inf, -np.inf, -.001, np.nextafter(1., np.inf), 81.55):
        assert not broadphase._ball_supported(rvw, PARAMETERS, horizon)
    for row in range(3):
        for bad in (np.nan, np.inf, -np.inf):
            changed = rvw.copy(); changed[row, 0] = bad
            assert not broadphase._ball_supported(changed, PARAMETERS, .1)
    for speed_z in (np.nextafter(0., 1.), 1e-12, .1):
        changed = rvw.copy(); changed[1, 2] = speed_z
        assert not broadphase._ball_supported(changed, PARAMETERS, .1)
    for parameter in range(5):
        changed = PARAMETERS.copy(); changed[parameter] = np.nan
        assert not broadphase._ball_supported(rvw, changed, .1)
    for kind, geometry in ((0, np.asarray([[1., 0., 0., 0., 0., .036, 0., 1., .036, 0.]])),
                           (1, np.asarray([[0., 0., .03]])), (2, np.asarray([[0., 0., .0645]]))):
        assert broadphase._geometry_supported(geometry, kind)
        changed = geometry.copy(); changed[0, 0] = np.nan
        assert not broadphase._geometry_supported(changed, kind)
        changed = geometry.copy()
        if kind == 0:
            changed[0, 8] += 1e-12
        else:
            changed[0, 2] = 1e-9
        assert not broadphase._geometry_supported(changed, kind)
        for horizon in (np.inf, -1., 2.):
            old, new, _ = _compare_rows(rvw[None, ...], np.asarray([const.rolling]), PARAMETERS[None, ...], geometry, kind, np.asarray([horizon]))
            np.testing.assert_array_equal(new, old)


def test_corrupted_or_scaled_cached_line_coefficients_use_the_original_kernel():
    rvw = _rolling(x=0., y=0., vx=1.)
    original = np.asarray([[1., 0., -.35, .35, -.5, .036576, .35, .5, .036576, 0.]])
    arguments = (rvw[None, ...], np.asarray([const.rolling]), PARAMETERS[None, ...], np.asarray([0]))
    assert broadphase._geometry_supported(original, 0)
    for mode in ("shifted-constant", "scaled-equation"):
        geometry = original.copy()
        if mode == "shifted-constant":
            geometry[0, 2] += .001
        else:
            geometry[0, :3] *= 2
        assert not broadphase._geometry_supported(geometry, 0)
        old = _table_rows(*arguments, geometry, 0)
        actual = broadphase._table_rows_pruned(*arguments, geometry, 0, np.asarray([.1]))
        assert np.isfinite(old[0, 0]) and old[0, 0] > .1
        np.testing.assert_array_equal(actual, old)


def test_random_actual_table_rows_keep_every_root_accepted_before_its_regime_transition():
    system = _restore_system(PhysicsEngine.new_match(14))
    rng = np.random.default_rng(261106)
    accepted = pruned = 0
    for kind in range(3):
        geometry = _geometry(system, kind)
        for _ in range(100):
            count = 6
            states = np.asarray([const.sliding, const.rolling, const.stationary,
                                 const.spinning, const.pocketed, const.airborne])
            params = np.tile(PARAMETERS, (count, 1))
            params[:, 0] = rng.uniform(.02, .05, count)
            params[:, 1] = rng.uniform(.1, .25, count)
            params[:, 2] = rng.uniform(.1, .3, count)
            params[:, 3] = rng.uniform(.01, .03, count)
            rvws = rng.uniform(-1, 1, (count, 3, 3))
            rvws[:, 0, 0] = rng.uniform(.1, .9, count); rvws[:, 0, 1] = rng.uniform(.1, 1.8, count)
            rvws[:, 0, 2] = params[:, 0]; rvws[:, 1] *= .1; rvws[:, 1, 2] = 0.; rvws[:, 2] *= 8
            # Two deliberately close, slow trajectories ensure the property is
            # not vacuous on mostly distant/infinite roots.
            for index in (0, 1):
                target = geometry[int(rng.integers(len(geometry)))]; radius = params[index, 0]
                if kind == 0:
                    normal = target[:2] / np.linalg.norm(target[:2])
                    sign = 1. if target[9] == 1 else -1.
                    rvws[index, 0, :2] = (target[3:5] + target[6:8]) / 2 + sign * normal * (radius + 1e-5)
                    rvws[index, 1, :2] = -sign * normal * .03
                else:
                    contact = target[2] + (radius if kind == 1 else 0.)
                    rvws[index, 0, :2] = target[:2] + [contact + 1e-5, 0.]
                    rvws[index, 1, :2] = [-.03, 0.]
                rvws[index, 2] = 0.
            rvws[-1, 0, 2] += .2; rvws[-1, 1, 2] = -.1
            horizons = np.full(count, np.inf)
            horizons[0] = get_slide_time(rvws[0], params[0, 0], params[0, 2], params[0, 4])
            horizons[1] = get_roll_time(rvws[1], params[1, 3], params[1, 4])
            before, after, kept = _compare_rows(rvws, states, params, geometry, kind, horizons)
            accepted += kept
            pruned += int(np.count_nonzero(np.isfinite(before) & np.isinf(after)))
    assert accepted >= 500 and pruned >= 100, (accepted, pruned)


def test_changed_legacy_root_filter_contract_falls_back_without_running_pruning():
    marker = object()
    arguments = (_rolling()[None, ...], np.asarray([const.rolling]), PARAMETERS[None, ...],
                 np.asarray([0]), np.asarray([[0., 0., .0645]]), 2, np.asarray([.1]))
    for changed in (object(), SimpleNamespace(py_func=SimpleNamespace(__defaults__=(1e-3, 1e-2, 1e-9)))):
        with patch.object(broadphase, "get_real_positive_smallest_root", changed), patch.object(broadphase, "_table_rows", return_value=marker) as old, patch.object(broadphase, "_table_rows_pruned_kernel", side_effect=AssertionError("unexpected pruning")):
            assert broadphase._table_rows_pruned(*arguments) is marker
            old.assert_called_once_with(*arguments[:-1])


def test_transition_horizons_are_inclusive_outward_and_missing_or_invalid_values_are_conservative():
    shot = _restore_system(PhysicsEngine.new_match(1)); shot.t = .25
    cache = OnlineCollisionCache.create(); cache._online_prune_transitions = True
    transitions = TransitionCache.create(shot)
    keys = list(shot.balls); absolute = np.nextafter(shot.t, np.inf)
    transitions.transitions[keys[0]] = null_event(absolute)
    transitions.transitions[keys[1]] = null_event(np.nan)
    transitions.transitions[keys[2]] = null_event(np.nextafter(shot.t, -np.inf))
    workspace = detection._prepare_workspace(shot, cache, transitions)
    assert workspace[4][0] >= absolute - shot.t and workspace[4][0] > 0
    assert np.isinf(workspace[4][1]) and np.isinf(workspace[4][2])
    del transitions.transitions[keys[-1]]
    assert detection._prepare_workspace(shot, cache, transitions)[4] is None
    cache._online_prune_transitions = False
    assert detection._prepare_workspace(shot, cache, TransitionCache.create(shot))[4] is None


def test_filtered_transitions_keep_unpruned_semantics_and_direct_states_default_to_no_pruning():
    source = _restore_system(PhysicsEngine.new_match(15)); source.strike(V0=1., phi=95.)
    direct = _OnlineSimulationState(source.copy(), _engine())
    assert not getattr(direct.collision_cache, "_online_prune_transitions", False)
    for include in (set(), {EventType.STICK_BALL, EventType.BALL_BALL}, INCLUDED_EVENTS - {EventType.SLIDING_ROLLING}):
        expected = simulate(source, engine=_engine(), include=include, max_events=3)
        with patch.object(detection, "_PRUNED_TABLE_ROWS", side_effect=AssertionError("filtered transitions must not prune")), patch.object(detection, "_PRUNED_BALL_PAIRS", side_effect=AssertionError("filtered transitions must not prune pairs")):
            actual = simulate_online(source, engine=_engine(), include=include, max_events=3)
        assert [(e.event_type, e.ids, e.time) for e in actual.events] == [(e.event_type, e.ids, e.time) for e in expected.events]
        for ball_id in expected.balls:
            np.testing.assert_array_equal(actual.balls[ball_id].state.rvw, expected.balls[ball_id].state.rvw)


@pytest.mark.parametrize("case_name", ["recorded_dense_1675", "weak_dense_break"])
def test_complete_dense_trace_preserves_events_states_and_every_history_sample(case_name):
    case = next(case for case in build_cases() if case.name == case_name)
    first, second = _restore_system(case.state), _restore_system(case.state)
    for shot in (first, second): shot.strike(**case.shot)
    baseline = _SimulationState(first, _engine())
    actual = _OnlineSimulationState(second, _engine())
    actual.collision_cache._online_prune_transitions = True
    baseline.init(); actual.init()
    pruned_future = pair_pruned_future = 0
    while not baseline.done:
        old, new = baseline.step(), actual.step()
        assert (new.event_type, new.ids, new.time) == (old.event_type, old.ids, old.time)
        assert actual.done == baseline.done
        np.testing.assert_array_equal(np.asarray([b.state.rvw for b in second.balls.values()]),
                                      np.asarray([b.state.rvw for b in first.balls.values()]))
        assert [b.state.s for b in second.balls.values()] == [b.state.s for b in first.balls.values()]
        for kind in (EventType.BALL_LINEAR_CUSHION, EventType.BALL_CIRCULAR_CUSHION, EventType.BALL_POCKET):
            for pair, time in baseline.collision_cache.times.get(kind, {}).items():
                if np.isfinite(time) and np.isinf(actual.collision_cache.times[kind][pair]):
                    # Only values beyond their real pending transition may be
                    # changed to infinity; the event/root itself is unchanged.
                    assert time > actual.transition_cache.transitions[pair[0]].time
                    pruned_future += 1
        for pair, time in baseline.collision_cache.times.get(EventType.BALL_BALL, {}).items():
            if np.isfinite(time) and np.isinf(actual.collision_cache.times[EventType.BALL_BALL][pair]):
                assert time > min(actual.transition_cache.transitions[ball_id].time for ball_id in pair)
                pair_pruned_future += 1
        if not baseline.done:
            baseline.update_caches(old); actual.update_caches(new)
    assert len(first.events) >= case.minimum_events
    assert pruned_future > 0, "The full trace must actually enable and exercise pruning"
    assert pair_pruned_future > 0, "The full trace must genuinely exercise ball-pair pruning too"
    assert first.t == second.t
    for ball_id in first.balls:
        before, after = first.balls[ball_id].history, second.balls[ball_id].history
        assert len(before) == len(after)
        assert [s.t for s in before] == [s.t for s in after]
        assert [s.s for s in before] == [s.s for s in after]
        np.testing.assert_array_equal(np.asarray([s.rvw for s in before]), np.asarray([s.rvw for s in after]))
