"""Conservative online ball-pair rejection within cached transition horizons.

Only the private online simulator enables this adapter. Rejected future times
remain irrelevant until at least one participating ball's next transition,
which invalidates that pair. Include filters and unsupported callers retain
the unpruned detector. All surviving pairs use the unchanged ``_ball_batch``.

Each ball's box is calculated once, through min(own horizon, 1 second). A pair
is considered only when min(its two horizons) <= 1 second, so these cached boxes
enclose at least its complete inclusive validity window. Longer boxes are only
more conservative. Stationary/spinning counterparts use their unchanged static
position polynomial. Both boxes retain the existing complex-root tube and 1 mm
ambiguity band; expansion by both ball radii preserves current-overlap events.

As with the table broadphase, this is guarded engineering for finite web-game
inputs, not an arbitrary floating-point quartic backward-error theorem.
"""

import numpy as np
from numba import jit

import pooltool.constants as const
from pooltool.ptmath.roots.core import get_real_positive_smallest_root

from .broadphase import _ROOT_DEFAULTS, _ball_supported, _down, _motion_box, _up
from .detection import _ball_batch


@jit(nopython=True, cache=const.use_numba_cache)
def _boxes_disjoint(first, second, radius):
    # _motion_box already includes the complex-root tube and a 1 mm ambiguity
    # band per ball. Add the equal physical radii only for this rejection test;
    # no collision radius or root calculation is changed.
    first_margin = _up(radius + first[4])
    second_margin = _up(radius + second[4])
    return (
        _up(first[1] + first_margin) < _down(second[0] - second_margin)
        or _down(first[0] - first_margin) > _up(second[1] + second_margin)
        or _up(first[3] + first_margin) < _down(second[2] - second_margin)
        or _down(first[2] - first_margin) > _up(second[3] + second_margin)
    )


@jit(nopython=True, cache=const.use_numba_cache)
def _ball_pairs_pruned_kernel(rvws, states, params, pairs, horizons):
    # Small missing-pair batches cost less to evaluate directly than to prepare
    # two sets of broadphase coefficients and boxes. This changes no semantics.
    if len(pairs) < 4:
        return _ball_batch(rvws, states, params, pairs)

    count = len(rvws)
    prepared = np.zeros(count, dtype=np.bool_)
    supported = np.zeros(count, dtype=np.bool_)
    boxes = np.empty((count, 5), dtype=np.float64)
    eligible = np.empty(len(pairs), dtype=np.int64)
    remaining = 0
    result = np.full(len(pairs), np.inf)

    for pair_index in range(len(pairs)):
        first, second = pairs[pair_index]
        s1, s2 = states[first], states[second]
        # Match the stock batch's cheap early exits, before overlap testing.
        if s1 == const.pocketed or s2 == const.pocketed:
            continue
        if ((s1 == const.stationary or s1 == const.spinning)
                and (s2 == const.stationary or s2 == const.spinning)):
            continue

        can_prune = (
            s1 in (const.stationary, const.spinning, const.sliding, const.rolling)
            and s2 in (const.stationary, const.spinning, const.sliding, const.rolling)
            and params[first, 0] == params[second, 0]
        )
        if can_prune:
            h1, h2 = horizons[first], horizons[second]
            # Infinity is legitimate for stationary balls, but NaN/negative
            # horizons are not evidence of a safe finite pair validity window.
            can_prune = not (np.isnan(h1) or np.isnan(h2) or h1 < 0. or h2 < 0.)
        if can_prune:
            pair_horizon = min(h1, h2)
            can_prune = np.isfinite(pair_horizon) and pair_horizon <= 1.

        if can_prune:
            for index in (first, second):
                if prepared[index]:
                    continue
                prepared[index] = True
                horizon = min(horizons[index], 1.)
                if not _ball_supported(rvws[index], params[index], horizon):
                    continue
                box = _motion_box(rvws[index], states[index], params[index], horizon)
                if box[0]:
                    supported[index] = True
                    boxes[index, 0] = box[1]
                    boxes[index, 1] = box[2]
                    boxes[index, 2] = box[3]
                    boxes[index, 3] = box[4]
                    boxes[index, 4] = box[5]
            can_prune = supported[first] and supported[second]

        if can_prune and _boxes_disjoint(boxes[first], boxes[second], params[first, 0]):
            continue
        eligible[remaining] = pair_index
        remaining += 1

    if not remaining:
        return result
    if remaining == len(pairs):
        return _ball_batch(rvws, states, params, pairs)

    selected = pairs[eligible[:remaining]]
    times = _ball_batch(rvws, states, params, selected)
    for index in range(remaining):
        result[eligible[index]] = times[index]
    return result


def _ball_pairs_pruned(rvws, states, params, pairs, horizons):
    """Unchanged relative collision times, except safely deferred future pairs."""
    implementation = getattr(get_real_positive_smallest_root, "py_func", None)
    if implementation is None or implementation.__defaults__ != _ROOT_DEFAULTS:
        return _ball_batch(rvws, states, params, pairs)
    if (not isinstance(rvws, np.ndarray) or rvws.dtype != np.float64
            or rvws.ndim != 3 or rvws.shape[1:] != (3, 3)
            or not isinstance(params, np.ndarray) or params.dtype != np.float64
            or params.ndim != 2 or params.shape != (len(rvws), 5)
            or not isinstance(states, np.ndarray) or states.dtype != np.int64
            or states.ndim != 1 or len(states) != len(rvws)
            or not isinstance(pairs, np.ndarray) or pairs.ndim != 2
            or pairs.shape[1] != 2 or pairs.dtype != np.int64
            or not isinstance(horizons, np.ndarray) or horizons.ndim != 1
            or horizons.dtype != np.float64 or len(horizons) != len(rvws)):
        return _ball_batch(rvws, states, params, pairs)
    return _ball_pairs_pruned_kernel(rvws, states, params, pairs, horizons)
