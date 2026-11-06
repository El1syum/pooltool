"""Independent exact-root gates for the private ball-pair broadphase.

The unchanged batch detector is the oracle. Only future cache entries beyond
both balls' current shared validity window may become infinity; accepted roots
inside that inclusive window must remain bit-for-bit unchanged.
"""
from itertools import combinations
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

import pooltool.constants as const
from online.server import pair_broadphase
from online.server.detection import _ball_batch
from pooltool.physics.utils import get_roll_time, get_slide_time


PARAMETERS = np.asarray([.028575, .170097, .2, .01, 9.81])


def _rolling(x=0., y=.5, vx=1., vy=0.):
    radius = PARAMETERS[0]
    return np.asarray([[x, y, radius], [vx, vy, 0.], [-vy / radius, vx / radius, 0.]])


def _arguments():
    rvws = np.asarray([_rolling(), _rolling(x=.35, vx=0.), _rolling(x=2., vx=0.)])
    states = np.asarray([const.rolling, const.stationary, const.spinning], dtype=np.int64)
    params = np.tile(PARAMETERS, (3, 1))
    pairs = np.asarray([[0, 1], [0, 2], [1, 2], [0, 1]], dtype=np.int64)
    horizons = np.asarray([.1, np.inf, np.inf])
    return rvws, states, params, pairs, horizons


def _compare(rvws, states, params, pairs, horizons):
    originals = [item.copy() for item in (rvws, states, params, pairs, horizons)]
    before = _ball_batch(rvws, states, params, pairs)
    after = pair_broadphase._ball_pairs_pruned(rvws, states, params, pairs, horizons)
    windows = np.minimum(horizons[pairs[:, 0]], horizons[pairs[:, 1]])
    retained = np.isfinite(before) & (before <= windows)
    np.testing.assert_array_equal(after[retained], before[retained])
    assert np.all((after == before) | (np.isinf(after) & np.isfinite(before) & ~retained))
    for item, original in zip((rvws, states, params, pairs, horizons), originals):
        np.testing.assert_array_equal(item, original)
    return before, after, int(np.count_nonzero(retained))


def test_far_future_pairs_prune_but_overlap_and_inclusive_horizon_roots_survive():
    arguments = _arguments()
    before, after, _ = _compare(*arguments)
    assert np.isfinite(before[[0, 1, 3]]).all()
    assert (before[[0, 1, 3]] > .1).all()
    assert np.isinf(after).all(), "At least four pairs must genuinely exercise pruning"
    arguments[0][1, 0, 0] = .04
    before, after, _ = _compare(*arguments)
    assert before[0] == 0. and after[0] == 0. and after[3] == 0.

    for direction in (-np.inf, np.inf):
        rvws, states, params, pairs, horizons = _arguments()
        endpoint = .1 - .04905 * .1 * .1
        rvws[1, 0, 0] = np.nextafter(endpoint + 2 * PARAMETERS[0], direction)
        before, after, _ = _compare(rvws, states, params, pairs, horizons)
        assert np.isfinite(before[0])
        np.testing.assert_array_equal(after[[0, 3]], before[[0, 3]])


def test_static_spinning_and_both_moving_use_minimum_horizon_and_preserve_order():
    rvws, states, params, _, _ = _arguments()
    rvws[1] = _rolling(x=.1, vx=-.05)
    rvws[0] = _rolling(vx=.1)
    states[1] = const.rolling
    pairs = np.asarray([[0, 1], [1, 0], [0, 2], [0, 1], [2, 0]], dtype=np.int64)
    horizons = np.asarray([.9, .5, np.inf])
    before, after, retained = _compare(rvws, states, params, pairs, horizons)
    assert retained >= 3
    np.testing.assert_array_equal(after[[0, 1, 3]], before[[0, 1, 3]])
    assert np.isinf(after[[2, 4]]).all()
    # A shorter horizon can belong to either participant. Cached own-boxes may
    # extend farther and retain a false positive, but may not change its root.
    for horizons in (np.asarray([.01, .5, np.inf]), np.asarray([.9, .01, np.inf])):
        before, after, _ = _compare(rvws, states, params, pairs, horizons)
        assert (before[[0, 1, 3]] > .01).all()
        assert np.all((after[[0, 1, 3]] == before[[0, 1, 3]]) | np.isinf(after[[0, 1, 3]]))
    _, after, _ = _compare(rvws, states, params, pairs, np.asarray([.01, .01, np.inf]))
    assert np.isinf(after[[0, 1, 3]]).all()


def test_near_complex_pair_roots_across_absolute_relative_cutoff_remain_exact():
    accepted = 0
    for speed in (.09, 8.):
        for closest in (1e-7, 1e-5, .0005, .000999999, .001, .001000001, .01, .1):
            for gap in (0., np.spacing(2 * PARAMETERS[0]), 1e-14, 1e-10, 1e-6, .01):
                x = .04905 * closest * closest - speed * closest
                rvws = np.asarray([_rolling(x=x, y=2 * PARAMETERS[0] + gap, vx=speed),
                                   _rolling(y=0., vx=0.)])
                states = np.asarray([const.rolling, const.spinning], dtype=np.int64)
                params = np.tile(PARAMETERS, (2, 1))
                pairs = np.asarray([[0, 1], [1, 0], [0, 1], [1, 0]], dtype=np.int64)
                horizon = min(1., get_roll_time(rvws[0], .01, 9.81))
                before, after, kept = _compare(rvws, states, params, pairs, np.asarray([horizon, np.inf]))
                accepted += kept
                if speed == .09 and closest == .0005 and gap == 1e-14:
                    assert kept == 4 and 0. < before[0] < .001
                    np.testing.assert_array_equal(after, before)
    assert accepted >= 100, "The stock numerical complex-root acceptance must actually be tested"


def test_heterogeneous_radius_keeps_legacy_first_radius_semantics_unpruned():
    rvws, states, params, pairs, horizons = _arguments()
    params[1, 0] *= 1.1
    params[2, 0] *= .8
    before = _ball_batch(rvws, states, params, pairs)
    after = pair_broadphase._ball_pairs_pruned(rvws, states, params, pairs, horizons)
    assert np.isfinite(before[[0, 1, 3]]).all()
    np.testing.assert_array_equal(after, before)


def test_invalid_horizons_and_unsupported_motion_states_keep_exact_original_values():
    for horizon in (np.nan, -1., np.inf, np.nextafter(1., np.inf)):
        arguments = _arguments()
        arguments[-1][0] = horizon
        np.testing.assert_array_equal(pair_broadphase._ball_pairs_pruned(*arguments),
                                      _ball_batch(*arguments[:-1]))
    for unsupported in ("airborne", "nonplanar", "extreme-coordinate", "extreme-parameter"):
        arguments = _arguments()
        if unsupported == "airborne":
            arguments[1][0] = const.airborne
        elif unsupported == "nonplanar":
            arguments[0][0, 1, 2] = 1e-12
        elif unsupported == "extreme-coordinate":
            arguments[0][0, 0, 1] = 4.1
        else:
            arguments[2][0, 4] = 21.
        np.testing.assert_array_equal(pair_broadphase._ball_pairs_pruned(*arguments),
                                      _ball_batch(*arguments[:-1]))


def test_nonstandard_dtype_shape_or_root_filter_falls_back_before_pruning():
    marker = object()
    for item_index, dtype in ((0, np.float32), (1, np.int32), (2, np.float32),
                             (3, np.int32), (4, np.float32)):
        arguments = list(_arguments())
        arguments[item_index] = arguments[item_index].astype(dtype)
        with patch.object(pair_broadphase, "_ball_batch", return_value=marker) as old, patch.object(pair_broadphase, "_ball_pairs_pruned_kernel", side_effect=AssertionError("unsafe dtype must not prune")):
            assert pair_broadphase._ball_pairs_pruned(*arguments) is marker
            old.assert_called_once_with(*arguments[:-1])
    bad_shapes = ((0, lambda value: value[:, :2]),
                  (1, lambda value: value[:, None]),
                  (2, lambda value: value[:, :4]),
                  (3, lambda value: value.ravel()),
                  (4, lambda value: value[:, None]))
    for item_index, reshape in bad_shapes:
        arguments = list(_arguments())
        arguments[item_index] = reshape(arguments[item_index])
        with patch.object(pair_broadphase, "_ball_batch", return_value=marker) as old, patch.object(pair_broadphase, "_ball_pairs_pruned_kernel", side_effect=AssertionError("unsafe shape must not prune")):
            assert pair_broadphase._ball_pairs_pruned(*arguments) is marker
            old.assert_called_once_with(*arguments[:-1])
    for altered in (object(), SimpleNamespace(py_func=SimpleNamespace(__defaults__=(1e-3, 1e-2, 1e-9)))):
        arguments = _arguments()
        with patch.object(pair_broadphase, "get_real_positive_smallest_root", altered), patch.object(pair_broadphase, "_ball_batch", return_value=marker) as old, patch.object(pair_broadphase, "_ball_pairs_pruned_kernel", side_effect=AssertionError("changed root contract must not prune")):
            assert pair_broadphase._ball_pairs_pruned(*arguments) is marker
            old.assert_called_once_with(*arguments[:-1])


def test_small_batches_and_expanded_box_touching_boundaries_are_conservative():
    rvws, states, params, pairs, horizons = _arguments()
    for count in range(4):
        np.testing.assert_array_equal(pair_broadphase._ball_pairs_pruned(rvws, states, params, pairs[:count], horizons),
                                      _ball_batch(rvws, states, params, pairs[:count]))
    radius = PARAMETERS[0]
    first = np.asarray([0., 0., 0., 0., .001])
    for shift in (-np.inf, np.inf):
        distance = np.nextafter(2 * (radius + .001), shift)
        second = np.asarray([distance, distance, 0., 0., .001])
        # Outward rounding makes either one-ULP representation conservative.
        assert not pair_broadphase._boxes_disjoint(first, second, radius)
    second = np.asarray([1., 1., 1., 1., .001])
    assert pair_broadphase._boxes_disjoint(first, second, radius)


def test_random_pairs_preserve_all_accepted_roots_before_real_regime_transitions():
    rng = np.random.default_rng(26110642)
    accepted = pruned = 0
    for _ in range(100):
        count = 8
        states = np.asarray([const.sliding, const.rolling, const.stationary, const.spinning,
                             const.pocketed, const.airborne, const.rolling, const.sliding], dtype=np.int64)
        params = np.tile(PARAMETERS, (count, 1))
        params[:, 1] = rng.uniform(.1, .25, count)
        params[:, 2] = rng.uniform(.1, .3, count)
        params[:, 3] = rng.uniform(.01, .03, count)
        rvws = rng.uniform(-1, 1, (count, 3, 3))
        rvws[:, 0, :2] = rng.uniform(.1, 1.8, (count, 2))
        rvws[:, 0, 2] = PARAMETERS[0]; rvws[:, 1] *= .1; rvws[:, 1, 2] = 0.; rvws[:, 2] *= 4
        for index in (2, 3, 4):
            rvws[index, 1] = 0.
        for moving, static in ((0, 2), (6, 3)):
            rvws[moving, 0, :2] = [.5, .5 + .3 * moving]
            rvws[moving, 1, :2] = [.03, 0.]
            rvws[moving, 2] = 0.
            rvws[static, 0, :2] = rvws[moving, 0, :2] + [2 * PARAMETERS[0] + 1e-5, 0.]
        # This ordinary sliding polynomial has a finite prospective collision
        # after its earlier sliding→rolling transition. It supplies a repeatable
        # genuinely prunable pair in addition to the random coverage.
        rvws[3, 0, :2] = [.36, 1.5]
        rvws[6, 0, :2] = [.36 - 2 * PARAMETERS[0] - 1e-5, 1.5]
        rvws[7] = _rolling(x=0., y=1.5, vx=1.); rvws[7, 2] = 0.
        params[7, 2] = .1
        rvws[5, 0, 2] += .2; rvws[5, 1, 2] = -.1
        horizons = np.full(count, np.inf)
        for index, state in enumerate(states):
            if state == const.sliding:
                horizons[index] = get_slide_time(rvws[index], params[index, 0], params[index, 2], params[index, 4])
            elif state == const.rolling:
                horizons[index] = get_roll_time(rvws[index], params[index, 3], params[index, 4])
        base_pairs = list(combinations(range(count), 2))
        pairs = np.asarray(base_pairs + [(1, 0), (0, 2), (6, 3)], dtype=np.int64)
        _, after, kept = _compare(rvws, states, params, pairs, horizons)
        before = _ball_batch(rvws, states, params, pairs)
        accepted += kept
        pruned += int(np.count_nonzero(np.isfinite(before) & np.isinf(after)))
    assert accepted >= 300 and pruned >= 100, (accepted, pruned)
