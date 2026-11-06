"""Conservative table-target rejection before a ball's next transition.

The private online simulator alone supplies an outward-expanded transition
horizon, with every stock transition enabled and collision-cache invalidation
unchanged. A rejected target cannot be reached before that ball's trajectory
changes and its row is invalidated. The public detector/kernels are untouched.

Position bounds use outward-rounded interval arithmetic. A complex-root tube
also covers the legacy root filter's accepted imaginary components. A further
1 mm *no-prune ambiguity band* deliberately leaves near-boundary targets to the
original solver; it does not enlarge any physical ball, cushion or pocket.

This is an engineering guard for bounded, normal-sized web tables, not a proof
of arbitrary floating-point quartic-solver backward error. Nonfinite, extreme,
airborne, unsupported-filter or out-of-domain inputs use the original kernels.
Every surviving target is evaluated by those exact kernels in its original
order, including the circular kernel's original halved polynomial expressions.
"""

import numpy as np
from numba import jit

import pooltool.constants as const
from pooltool.ptmath.roots.core import get_real_positive_smallest_root

from .detection import (
    _circular_batch,
    _coefficients,
    _linear_batch,
    _pocket_batch,
    _table_rows,
)


_ROOT_DEFAULTS = (1e-3, 1e-3, 1e-9)
_ROUNDING_AMBIGUITY = .001


@jit(nopython=True, cache=const.use_numba_cache)
def _down(value):
    return np.nextafter(value, -np.inf)


@jit(nopython=True, cache=const.use_numba_cache)
def _up(value):
    return np.nextafter(value, np.inf)


@jit(nopython=True, cache=const.use_numba_cache)
def _axis_bounds(a, b, c, horizon, squared):
    a_product, b_product = a * squared, b * horizon
    a_low = _down(a_product) if a < 0. else 0.
    a_high = _up(a_product) if a >= 0. else 0.
    b_low = _down(b_product) if b < 0. else 0.
    b_high = _up(b_product) if b >= 0. else 0.
    return _down(_down(c + a_low) + b_low), _up(_up(c + a_high) + b_high)


@jit(nopython=True, cache=const.use_numba_cache)
def _geometry_supported(geometry, kind):
    for row in geometry:
        for value in row:
            if not np.isfinite(value):
                return False
        if kind == 0:
            if len(row) < 10 or row[5] != row[8]:
                return False
            dx, dy = row[6] - row[3], row[7] - row[4]
            if dx * dx + dy * dy <= 1e-12:
                return False
            if (abs(row[0]) > 16. or abs(row[1]) > 16.
                    or abs(row[2]) > 32.):
                return False
            for column in range(3, 9):
                if abs(row[column]) > 4.:
                    return False
            # Frozen segments normally compute these cached coefficients from
            # their endpoints. Replaced/corrupted cached properties must not let
            # the capsule AABB describe a different line from the old solver.
            if dx == 0.:
                if row[0] != 1. or row[1] != 0. or row[2] != -row[3]:
                    return False
            else:
                slope = dy / dx
                if (row[0] != -slope or row[1] != 1.
                        or row[2] != slope * row[3] - row[4]):
                    return False
        elif (abs(row[0]) > 4. or abs(row[1]) > 4.
              or not 1e-6 <= row[2] <= 1.):
            return False
    return True


@jit(nopython=True, cache=const.use_numba_cache)
def _ball_supported(rvw, parameters, horizon):
    # Beyond one second a loose box rarely rejects targets and provides no
    # useful benefit. Longer horizons retain the original calculation.
    if not np.isfinite(horizon) or not 0. <= horizon <= 1.:
        return False
    # A 2D-labelled custom state can still carry vertical velocity. In that
    # case the old coefficient construction and evolved XY projection need not
    # describe the same polynomial; leave it entirely to the original kernels.
    if rvw[1, 2] != 0.:
        return False
    for row in range(3):
        limit = 4. if row == 0 else 32. if row == 1 else 1e5
        for column in range(3):
            if not np.isfinite(rvw[row, column]) or abs(rvw[row, column]) > limit:
                return False
    for value in parameters:
        if not np.isfinite(value):
            return False
    radius, mass, sliding, rolling, gravity = parameters
    return (0.005 <= radius <= .1 and .01 <= mass <= 1.
            and 1e-4 <= sliding <= 1. and 1e-4 <= rolling <= .2
            and 1. <= gravity <= 20.)


@jit(nopython=True, cache=const.use_numba_cache)
def _motion_box(rvw, state, parameters, horizon):
    radius, _, sliding, rolling, gravity = parameters
    mu = sliding if state == const.sliding else rolling
    coeff = _coefficients(rvw, state, mu, gravity, radius)
    for value in coeff:
        if not np.isfinite(value):
            return False, 0., 0., 0., 0., 0.
    if (abs(coeff[0]) > 16. or abs(coeff[1]) > 16.
            or abs(coeff[2]) > 64. or abs(coeff[3]) > 64.
            or abs(coeff[4]) > 4. or abs(coeff[5]) > 4.):
        return False, 0., 0., 0., 0., 0.
    squared = _up(horizon * horizon)
    x_low, x_high = _axis_bounds(coeff[0], coeff[2], coeff[4], horizon, squared)
    y_low, y_high = _axis_bounds(coeff[1], coeff[3], coeff[5], horizon, squared)
    # z=u+iv accepted by the stock filter: |v| <= max(atol,rtol*min(H,cutoff)).
    # q(z)=q(u)-a*v² + i*v*(2*a*u+b). L1 bounds enclose its real-time position
    # in a circle expanded by delta*velocity_bound + delta²*acceleration_bound.
    imaginary = _up(max(1e-9, _up(1e-3 * min(horizon, 1e-3))))
    acceleration = _up(abs(coeff[0]) + abs(coeff[1]))
    velocity = _up(_up(abs(coeff[2]) + abs(coeff[3]))
                   + _up(_up(2. * horizon) * acceleration))
    ambiguity = _up(_up(imaginary * velocity)
                    + _up(_up(imaginary * imaginary) * acceleration))
    ambiguity = _up(ambiguity + _ROUNDING_AMBIGUITY)
    return True, x_low, x_high, y_low, y_high, ambiguity


@jit(nopython=True, cache=const.use_numba_cache)
def _target_disjoint(box, row, kind, ball_radius):
    _, x_low, x_high, y_low, y_high, ambiguity = box
    if kind == 0:
        radius = _up(ball_radius + ambiguity)
        target_x_low = _down(min(row[3], row[6]) - radius)
        target_x_high = _up(max(row[3], row[6]) + radius)
        target_y_low = _down(min(row[4], row[7]) - radius)
        target_y_high = _up(max(row[4], row[7]) + radius)
    else:
        # Circular jaws use R_ball + R_jaw. The original pocket time equation
        # uses R_pocket alone, not a sum with the ball radius.
        radius = _up(row[2] + ball_radius) if kind == 1 else row[2]
        radius = _up(radius + ambiguity)
        target_x_low = _down(row[0] - radius)
        target_x_high = _up(row[0] + radius)
        target_y_low = _down(row[1] - radius)
        target_y_high = _up(row[1] + radius)
    return (x_high < target_x_low or x_low > target_x_high
            or y_high < target_y_low or y_low > target_y_high)


@jit(nopython=True, cache=const.use_numba_cache)
def _table_rows_pruned_kernel(rvws, states, params, indices, geometry, kind, horizons):
    if not _geometry_supported(geometry, kind):
        return _table_rows(rvws, states, params, indices, geometry, kind)
    result = np.full((len(indices), len(geometry)), np.inf)
    for output_row in range(len(indices)):
        index = indices[output_row]
        state = states[index]
        if state in (const.stationary, const.spinning, const.pocketed):
            continue
        radius, mass, sliding, rolling, gravity = params[index]
        mu = sliding if state == const.sliding else rolling
        horizon = horizons[index] if index < len(horizons) else np.inf
        can_prune = (state in (const.sliding, const.rolling)
                     and _ball_supported(rvws[index], params[index], horizon))
        if can_prune:
            box = _motion_box(rvws[index], state, params[index], horizon)
            can_prune = box[0]
        if not can_prune:
            if kind == 0:
                result[output_row] = _linear_batch(rvws[index], state, mu, mass, gravity, radius, geometry)
            elif kind == 1:
                result[output_row] = _circular_batch(rvws[index], state, mu, mass, gravity, radius, geometry)
            else:
                result[output_row] = _pocket_batch(rvws[index], state, mu, mass, gravity, radius, geometry)
            continue
        eligible = np.empty(len(geometry), dtype=np.int64)
        count = 0
        for target in range(len(geometry)):
            if not _target_disjoint(box, geometry[target], kind, radius):
                eligible[count] = target
                count += 1
        if not count:
            continue
        subset = geometry[eligible[:count]]
        if kind == 0:
            times = _linear_batch(rvws[index], state, mu, mass, gravity, radius, subset)
        elif kind == 1:
            times = _circular_batch(rvws[index], state, mu, mass, gravity, radius, subset)
        else:
            times = _pocket_batch(rvws[index], state, mu, mass, gravity, radius, subset)
        for target in range(count):
            result[output_row, eligible[target]] = times[target]
    return result


def _table_rows_pruned(rvws, states, params, indices, geometry, kind, horizons):
    """Keep the original path if the legacy root-filter contract has changed."""
    implementation = getattr(get_real_positive_smallest_root, 'py_func', None)
    if implementation is None or implementation.__defaults__ != _ROOT_DEFAULTS:
        return _table_rows(rvws, states, params, indices, geometry, kind)
    return _table_rows_pruned_kernel(rvws, states, params, indices, geometry, kind, horizons)
