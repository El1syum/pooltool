"""Exact 2D detector batching for the authoritative web-game worker.

The public scalar Pooltool kernels remain the independent reference/fallback.
This adapter reuses their operations in exactly the same order, but calculates
each ball's planar polynomial once per batch rather than for every cushion/pair.
No fastmath, event tolerance, friction, root solver or simulation limit changes.
Frozen table components (including readonly endpoints) and frozen BallParams
can safely prepare arrays per collision cache. Strong references prevent object
ID reuse; metadata is local to a shot and never enters persisted match state.
Three-dimensional engines retain the original detector paths.
"""

from itertools import groupby
from operator import itemgetter

import numpy as np
from numba import jit

import pooltool.constants as const
import pooltool.ptmath as ptmath
from pooltool.events import (
    EventType, ball_ball_collision, ball_circular_cushion_collision,
    ball_linear_cushion_collision, ball_pocket_collision, null_event,
)
from pooltool.evolution.event_based._pair_cache import pair_cache
from pooltool.evolution.event_based.detect import EventDetector
from pooltool.evolution.event_based.detect.ball_ball import ball_ball_collision_time_2d
from pooltool.evolution.event_based.detect.ball_pocket import ball_pocket_collision_time
from pooltool.physics.evolve import evolve_ball_motion
from pooltool.physics.utils import get_u_vec
from pooltool.ptmath.roots import quadratic, quartic
from pooltool.ptmath.roots.core import get_real_positive_smallest_root


_overlapping = jit(nopython=True, cache=const.use_numba_cache)(ptmath.is_overlapping)


@jit(nopython=True, cache=const.use_numba_cache)
def _coefficients(rvw, state, mu, gravity, radius):
    if state == const.stationary or state == const.spinning or state == const.pocketed:
        return np.array([0., 0., 0., 0., rvw[0, 0], rvw[0, 1]])
    phi = ptmath.angle(rvw[1])
    v = ptmath.norm3d(rvw[1])
    u = get_u_vec(rvw, radius, phi, state)
    K = -0.5 * mu * gravity
    cos_phi = np.cos(phi)
    sin_phi = np.sin(phi)
    ax = K * (u[0] * cos_phi - u[1] * sin_phi)
    ay = K * (u[0] * sin_phi + u[1] * cos_phi)
    bx, by = v * cos_phi, v * sin_phi
    return np.array([ax, ay, bx, by, rvw[0, 0], rvw[0, 1]])


@jit(nopython=True, cache=const.use_numba_cache)
def _plane_time(rvw, state, row, mu, mass, gravity, radius, coeff):
    ax, ay, bx, by, cx, cy = coeff
    lx, ly, l0 = row[0], row[1], row[2]
    p1, p2, direction = row[3:6], row[6:9], row[9]
    A = lx * ax + ly * ay
    B = lx * bx + ly * by
    if direction == 0:
        C = l0 + lx * cx + ly * cy + radius * np.sqrt(lx * lx + ly * ly)
        root1, root2 = quadratic.solve(A, B, C)
        roots = [root1, root2]
    elif direction == 1:
        C = l0 + lx * cx + ly * cy - radius * np.sqrt(lx * lx + ly * ly)
        root1, root2 = quadratic.solve(A, B, C)
        roots = [root1, root2]
    else:
        C1 = l0 + lx * cx + ly * cy + radius * np.sqrt(lx * lx + ly * ly)
        C2 = l0 + lx * cx + ly * cy - radius * np.sqrt(lx * lx + ly * ly)
        root1, root2 = quadratic.solve(A, B, C1)
        root3, root4 = quadratic.solve(A, B, C2)
        roots = [root1, root2, root3, root4]
    min_time = np.inf
    for root in roots:
        if np.isnan(root) or np.abs(root.imag) > const.EPS or root.real <= const.EPS:
            continue
        rvw_dtau, _ = evolve_ball_motion(state, rvw, radius, mass, mu, 1, mu, gravity, root.real)
        s_score = -np.dot(p1 - rvw_dtau[0], p2 - p1) / np.dot(p2 - p1, p2 - p1)
        if not (0 <= s_score <= 1):
            continue
        if root.real < min_time:
            min_time = root.real
    return min_time


@jit(nopython=True, cache=const.use_numba_cache)
def _circle_time(coeff, a, b, radius):
    ax, ay, bx, by, cx, cy = coeff
    A = 0.5 * (ax * ax + ay * ay)
    B = ax * bx + ay * by
    C = ax * (cx - a) + ay * (cy - b) + 0.5 * (bx * bx + by * by)
    D = bx * (cx - a) + by * (cy - b)
    E = 0.5 * (a * a + b * b + cx * cx + cy * cy - radius * radius) - (cx * a + cy * b)
    return get_real_positive_smallest_root(quartic.solve(A, B, C, D, E))


@jit(nopython=True, cache=const.use_numba_cache)
def _ball_time(c1, c2, radius):
    Ax, Ay = c2[0] - c1[0], c2[1] - c1[1]
    Bx, By = c2[2] - c1[2], c2[3] - c1[3]
    Cx, Cy = c2[4] - c1[4], c2[5] - c1[5]
    a = Ax * Ax + Ay * Ay
    b = 2 * Ax * Bx + 2 * Ay * By
    c = Bx * Bx + 2 * Ax * Cx + 2 * Ay * Cy + By * By
    d = 2 * Bx * Cx + 2 * By * Cy
    e = Cx * Cx + Cy * Cy - 4 * radius * radius
    if a == 0.0:
        return get_real_positive_smallest_root(quadratic.solve(c, d, e))
    return get_real_positive_smallest_root(quartic.solve(a, b, c, d, e))


@jit(nopython=True, cache=const.use_numba_cache)
def _ball_batch(rvws, states, params, pairs):
    result = np.empty(len(pairs))
    coeffs = np.empty((len(rvws), 6))
    computed = np.zeros(len(rvws), dtype=np.bool_)
    for i in range(len(pairs)):
        first, second = pairs[i]
        s1, s2 = states[first], states[second]
        p1, p2 = params[first], params[second]
        if s1 == const.pocketed or s2 == const.pocketed:
            result[i] = np.inf
        elif (s1 == const.stationary or s1 == const.spinning) and (s2 == const.stationary or s2 == const.spinning):
            result[i] = np.inf
        elif _overlapping(rvws[first], rvws[second], p1[0], p2[0]):
            result[i] = 0.
        elif p1[0] == p2[0]:
            if not computed[first]:
                coeffs[first] = _coefficients(rvws[first], s1, p1[2] if s1 == const.sliding else p1[3], p1[4], p1[0])
                computed[first] = True
            if not computed[second]:
                coeffs[second] = _coefficients(rvws[second], s2, p2[2] if s2 == const.sliding else p2[3], p2[4], p2[0])
                computed[second] = True
            result[i] = _ball_time(coeffs[first], coeffs[second], p1[0])
        else:
            # The original 2D API uses the first radius in both trajectories.
            # Retain its exact behavior for heterogeneous, non-game fixtures.
            result[i] = ball_ball_collision_time_2d(
                rvws[first], rvws[second], s1, s2,
                p1[2] if s1 == const.sliding else p1[3],
                p2[2] if s2 == const.sliding else p2[3],
                p1[1], p2[1], p1[4], p2[4], p1[0],
            )
    return result


@jit(nopython=True, cache=const.use_numba_cache)
def _linear_batch(rvw, state, mu, mass, gravity, radius, geometry):
    result = np.empty(len(geometry))
    coeff = _coefficients(rvw, state, mu, gravity, radius)
    for i in range(len(geometry)):
        if state == const.stationary or state == const.pocketed or state == const.spinning or state == const.airborne:
            result[i] = np.inf
        else:
            result[i] = _plane_time(rvw, state, geometry[i], mu, mass, gravity, radius, coeff)
    return result


@jit(nopython=True, cache=const.use_numba_cache)
def _circular_batch(rvw, state, mu, mass, gravity, radius, geometry):
    result = np.empty(len(geometry))
    coeff = _coefficients(rvw, state, mu, gravity, radius)
    for i in range(len(geometry)):
        if state == const.stationary or state == const.pocketed or state == const.spinning or state == const.airborne:
            result[i] = np.inf
        else:
            ax, ay, bx, by, cx, cy = coeff
            a, b, r = geometry[i]
            A = 0.5 * (ax * ax + ay * ay)
            B = ax * bx + ay * by
            C = ax * (cx - a) + ay * (cy - b) + 0.5 * (bx * bx + by * by)
            D = bx * (cx - a) + by * (cy - b)
            # Do not algebraically simplify this original expression.
            E = 0.5 * (a * a + b * b + cx * cx + cy * cy - (r + radius) * (r + radius)) - (cx * a + cy * b)
            result[i] = get_real_positive_smallest_root(quartic.solve(A, B, C, D, E))
    return result


@jit(nopython=True, cache=const.use_numba_cache)
def _pocket_batch(rvw, state, mu, mass, gravity, radius, geometry):
    result = np.empty(len(geometry))
    coeff = _coefficients(rvw, state, mu, gravity, radius)
    for i in range(len(geometry)):
        row = geometry[i]
        if state == const.stationary or state == const.pocketed or state == const.spinning:
            result[i] = np.inf
        elif state == const.airborne:
            result[i] = ball_pocket_collision_time(rvw, state, row[0], row[1], row[2], mu, mass, gravity, radius)
        else:
            result[i] = _circle_time(coeff, row[0], row[1], row[2])
    return result


def _next_ball_event(shot, collision_cache):
    ids = tuple(shot.balls)
    cache = pair_cache(collision_cache, EventType.BALL_BALL, ids)
    pairs = cache.missing_pairs()
    if pairs:
        balls = list(shot.balls.values())
        identity = tuple(id(ball.params) for ball in balls)
        if getattr(cache, "_ball_identity", None) != identity:
            cache._ball_identity = identity
            cache._ball_params_refs = tuple(ball.params for ball in balls)
            cache._ball_params = np.asarray([
                [b.params.R, b.params.m, b.params.u_s, b.params.u_r, b.params.g]
                for b in balls
            ])
            cache._ball_indices = {ball_id: i for i, ball_id in enumerate(ids)}
        values = _ball_batch(
            np.asarray([ball.state.rvw for ball in balls]),
            np.asarray([ball.state.s for ball in balls]), cache._ball_params,
            np.asarray([[cache._ball_indices[a], cache._ball_indices[b]] for a, b in pairs]),
        )
        dict.update(cache, zip(pairs, (values + shot.t).tolist()))
    cache.complete_pairs()
    if not cache:
        return null_event(np.inf)
    key = min(cache, key=cache.__getitem__)
    return ball_ball_collision(ball1=shot.balls[key[0]], ball2=shot.balls[key[1]], time=cache[key])


def _next_table_event(shot, collision_cache, kind):
    if kind == "linear":
        objects = shot.table.cushion_segments.linear
        event_type, factory, batch = EventType.BALL_LINEAR_CUSHION, ball_linear_cushion_collision, _linear_batch
    elif kind == "circular":
        objects = shot.table.cushion_segments.circular
        event_type, factory, batch = EventType.BALL_CIRCULAR_CUSHION, ball_circular_cushion_collision, _circular_batch
    else:
        objects = shot.table.pockets
        event_type, factory, batch = EventType.BALL_POCKET, ball_pocket_collision, _pocket_batch
    if not objects:
        return null_event(np.inf)
    cache = pair_cache(collision_cache, event_type, tuple(shot.balls), tuple(objects))
    identity = tuple(id(obj) for obj in objects.values())
    if getattr(cache, "_shape_identity", None) != identity:
        if kind == "linear":
            rows = [[obj.lx, obj.ly, obj.l0, *obj.p1, *obj.p2, obj.direction] for obj in objects.values()]
        else:
            rows = [[obj.a, obj.b, obj.radius] for obj in objects.values()]
        cache._shape_identity = identity
        cache._shape_refs = tuple(objects.values())
        cache._shape_geometry = np.asarray(rows, dtype=np.float64)
        cache._shape_indices = {key: i for i, key in enumerate(objects)}
    for ball_id, values in groupby(cache.missing_pairs(), itemgetter(0)):
        pairs = list(values)
        ball = shot.balls[ball_id]
        state, params = ball.state, ball.params
        times = batch(
            state.rvw, state.s, params.u_s if state.s == const.sliding else params.u_r,
            params.m, params.g, params.R, cache._shape_geometry,
        )
        if len(pairs) != len(objects):
            times = times[[cache._shape_indices[key[1]] for key in pairs]]
        dict.update(cache, zip(pairs, (times + shot.t).tolist()))
    cache.complete_pairs()
    key = min(cache, key=cache.__getitem__)
    if kind == "pocket":
        return factory(ball=shot.balls[key[0]], pocket=objects[key[1]], time=cache[key])
    return factory(ball=shot.balls[key[0]], cushion=objects[key[1]], time=cache[key])


class OnlineEventDetector(EventDetector):
    """Per-engine override; does not monkeypatch the desktop/global detector."""

    def _ball_ball_event(self, shot, cache):
        return super()._ball_ball_event(shot, cache) if self.is_3d else _next_ball_event(shot, cache)

    def _linear_cushion_event(self, shot, cache):
        return super()._linear_cushion_event(shot, cache) if self.is_3d else _next_table_event(shot, cache, "linear")

    def _circular_cushion_event(self, shot, cache):
        return super()._circular_cushion_event(shot, cache) if self.is_3d else _next_table_event(shot, cache, "circular")

    def _pocket_event(self, shot, cache):
        return super()._pocket_event(shot, cache) if self.is_3d else _next_table_event(shot, cache, "pocket")
