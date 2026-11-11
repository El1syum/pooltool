"""Original full-cache detector traversal retained as a timing/equivalence oracle.

The four bodies are the pre-optimization algorithms from commit c91c3be. Keep
the original per-ball parameter reads, nested loops and minimum lookup: a helper
that only imitates the missing-pair list is not an accurate timing baseline.
Collision kernels, precision, event factories and tie order are unchanged.
"""

from itertools import combinations

import numpy as np

import pooltool.constants as const
import pooltool.ptmath as ptmath
from pooltool.events import (
    EventType, ball_ball_collision, ball_linear_cushion_collision,
    ball_circular_cushion_collision, ball_pocket_collision, null_event,
)
from pooltool.evolution.event_based.detect.ball_ball import (
    ball_ball_collision_time, ball_ball_collision_time_2d,
)
from pooltool.evolution.event_based.detect.ball_cushion import (
    ball_vertical_plane_collision_time, ball_vertical_cylinder_collision_time,
)
from pooltool.evolution.event_based.detect.ball_pocket import ball_pocket_collision_time


def get_next_ball_ball_event(shot, collision_cache, *, is_3d):
    cache = collision_cache.times.setdefault(EventType.BALL_BALL, {})
    for ball1, ball2 in combinations(shot.balls.values(), 2):
        ball_pair = (ball1.id, ball2.id)
        if ball_pair in cache:
            continue
        ball1_state = ball1.state
        ball1_params = ball1.params
        ball2_state = ball2.state
        ball2_params = ball2.params
        if ball1_state.s == const.pocketed or ball2_state.s == const.pocketed:
            cache[ball_pair] = np.inf
        elif ball1_state.s in const.nontranslating and ball2_state.s in const.nontranslating:
            cache[ball_pair] = np.inf
        elif ptmath.is_overlapping(ball1_state.rvw, ball2_state.rvw, ball1_params.R, ball2_params.R):
            cache[ball_pair] = shot.t
        else:
            if is_3d:
                dtau_E = ball_ball_collision_time(ball1, ball2)
            else:
                dtau_E = ball_ball_collision_time_2d(
                    rvw1=ball1_state.rvw, rvw2=ball2_state.rvw,
                    s1=ball1_state.s, s2=ball2_state.s,
                    mu1=ball1_params.u_s if ball1_state.s == const.sliding else ball1_params.u_r,
                    mu2=ball2_params.u_s if ball2_state.s == const.sliding else ball2_params.u_r,
                    m1=ball1_params.m, m2=ball2_params.m,
                    g1=ball1_params.g, g2=ball2_params.g, R=ball1_params.R,
                )
            cache[ball_pair] = shot.t + dtau_E
    if not cache:
        return null_event(np.inf)
    ball_pair = min(cache, key=cache.__getitem__)
    return ball_ball_collision(ball1=shot.balls[ball_pair[0]], ball2=shot.balls[ball_pair[1]], time=cache[ball_pair])


def get_next_ball_linear_cushion_event(shot, collision_cache):
    if not shot.table.has_linear_cushions:
        return null_event(np.inf)
    cache = collision_cache.times.setdefault(EventType.BALL_LINEAR_CUSHION, {})
    for ball in shot.balls.values():
        state = ball.state
        params = ball.params
        for cushion in shot.table.cushion_segments.linear.values():
            obj_ids = (ball.id, cushion.id)
            if obj_ids in cache:
                continue
            if ball.state.s in const.nontranslating:
                cache[obj_ids] = np.inf
                continue
            if ball.state.s == const.airborne:
                dtau_E = np.inf
            else:
                dtau_E = ball_vertical_plane_collision_time(
                    rvw=state.rvw, s=state.s, lx=cushion.lx, ly=cushion.ly,
                    l0=cushion.l0, p1=cushion.p1, p2=cushion.p2, direction=cushion.direction,
                    mu=params.u_s if state.s == const.sliding else params.u_r,
                    m=params.m, g=params.g, R=params.R,
                )
            cache[obj_ids] = shot.t + dtau_E
    obj_ids = min(cache, key=cache.__getitem__)
    return ball_linear_cushion_collision(ball=shot.balls[obj_ids[0]], cushion=shot.table.cushion_segments.linear[obj_ids[1]], time=cache[obj_ids])


def get_next_ball_circular_cushion_event(shot, collision_cache):
    if not shot.table.has_circular_cushions:
        return null_event(np.inf)
    cache = collision_cache.times.setdefault(EventType.BALL_CIRCULAR_CUSHION, {})
    for ball in shot.balls.values():
        state = ball.state
        params = ball.params
        for cushion in shot.table.cushion_segments.circular.values():
            obj_ids = (ball.id, cushion.id)
            if obj_ids in cache:
                continue
            if ball.state.s in const.nontranslating:
                cache[obj_ids] = np.inf
                continue
            if ball.state.s == const.airborne:
                dtau_E = np.inf
            else:
                dtau_E = ball_vertical_cylinder_collision_time(
                    rvw=state.rvw, s=state.s, a=cushion.a, b=cushion.b, r=cushion.radius,
                    mu=params.u_s if state.s == const.sliding else params.u_r,
                    m=params.m, g=params.g, R=params.R,
                )
            cache[obj_ids] = shot.t + dtau_E
    ball_id, cushion_id = min(cache, key=cache.__getitem__)
    return ball_circular_cushion_collision(ball=shot.balls[ball_id], cushion=shot.table.cushion_segments.circular[cushion_id], time=cache[(ball_id, cushion_id)])


def get_next_ball_pocket_event(shot, collision_cache):
    if not shot.table.has_pockets:
        return null_event(np.inf)
    cache = collision_cache.times.setdefault(EventType.BALL_POCKET, {})
    for ball in shot.balls.values():
        state = ball.state
        params = ball.params
        for pocket in shot.table.pockets.values():
            obj_ids = (ball.id, pocket.id)
            if obj_ids in cache:
                continue
            if state.s in const.nontranslating:
                cache[obj_ids] = np.inf
                continue
            dtau_E = ball_pocket_collision_time(
                rvw=state.rvw, s=state.s, a=pocket.a, b=pocket.b, r=pocket.radius,
                mu=params.u_s if state.s == const.sliding else params.u_r,
                m=params.m, g=params.g, R=params.R,
            )
            cache[obj_ids] = shot.t + dtau_E
    ball_id, pocket_id = min(cache, key=cache.__getitem__)
    return ball_pocket_collision(ball=shot.balls[ball_id], pocket=shot.table.pockets[pocket_id], time=cache[(ball_id, pocket_id)])
