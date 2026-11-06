"""Online-only batching of the unchanged Pooltool motion evolution kernel.

This does not approximate trajectories or omit history. Every event still
produces a fresh BallState/rvw for every ball, with the upstream resolver,
detector/cache order and termination rules. Desktop and unsupported/custom
systems retain the public Pooltool simulator unchanged.
"""
from __future__ import annotations

import numpy as np
from numba import jit

import pooltool.constants as const
from pooltool.events import Event, EventType, null_event
from pooltool.evolution.continuous import continuize
from pooltool.evolution.engine import SimulationEngine
from pooltool.evolution.event_based.cache import TransitionCache
from pooltool.evolution.event_based.config import INCLUDED_EVENTS
from pooltool.evolution.event_based.simulate import _SimulationState, simulate
from pooltool.objects.ball.datatypes import Ball, BallState
from pooltool.objects.ball.params import BallParams
from pooltool.objects.table.components import (
    CircularCushionSegment, CushionSegments, LinearCushionSegment, Pocket,
)
from pooltool.objects.table.datatypes import Table
from pooltool.physics.evolve import evolve_ball_motion
from pooltool.physics.resolve.resolver import Resolver, default_resolver
from pooltool.system.datatypes import System

from .detection import OnlineEventDetector


_reference_resolver = default_resolver()
_STRATEGIES = (
    "ball_ball", "ball_linear_cushion", "ball_circular_cushion", "ball_pocket",
    "stick_ball", "ball_table", "transition",
)
_STRATEGY_TYPES = tuple(type(getattr(_reference_resolver, name)) for name in _STRATEGIES)
_FRICTION_TYPE = type(_reference_resolver.ball_ball.friction)
_PARAMETERS = ("R", "m", "u_s", "u_sp", "u_r", "g")
del _reference_resolver
_PRUNING_EVENTS = frozenset(INCLUDED_EVENTS)


def _fixed_layout(shot):
    """Only stock mappings/components can stay fixed during this guarded solve.

    Pocket contents and BallState remain mutable. The stock resolver does not
    replace balls, their frozen parameters, or the table's geometry mappings.
    Custom mappings/components retain all per-call detector identity checks.
    """
    table = shot.table
    return (type(shot.balls) is dict and type(table) is Table
            and type(table.cushion_segments) is CushionSegments
            and type(table.cushion_segments.linear) is dict
            and type(table.cushion_segments.circular) is dict
            and type(table.pockets) is dict
            and all(type(item) is LinearCushionSegment for item in table.cushion_segments.linear.values())
            and all(type(item) is CircularCushionSegment for item in table.cushion_segments.circular.values())
            and all(type(item) is Pocket for item in table.pockets.values()))


@jit(nopython=True, cache=const.use_numba_cache)
def _evolve_batch(rvws, states, parameters, dt):
    """One Python/JIT boundary; the stock scalar arithmetic is kept intact."""
    outputs = []
    for index in range(len(states)):
        row = parameters[index]
        rvw, _ = evolve_ball_motion(
            state=states[index], rvw=rvws[index], R=row[0], m=row[1],
            u_s=row[2], u_sp=row[3], u_r=row[4], g=row[5], t=dt,
        )
        # Keep the scalar kernel's separately allocated array, not a view of a
        # common output matrix. Live states and all historical states stay owned.
        outputs.append(rvw)
    return outputs


def _supports_batch(shot: System, engine: SimulationEngine | None) -> bool:
    if (type(shot) is not System or type(shot.balls) is not dict
            or type(engine) is not SimulationEngine or engine.is_3d):
        return False
    if (type(engine.detector) is not OnlineEventDetector or engine.detector.is_3d
            or type(engine.resolver) is not Resolver):
        return False
    if any(type(getattr(engine.resolver, name)) is not expected
           for name, expected in zip(_STRATEGIES, _STRATEGY_TYPES)):
        return False
    if type(engine.resolver.ball_ball.friction) is not _FRICTION_TYPE:
        return False
    return all(
        type(ball) is Ball and type(ball.state) is BallState
        and type(ball.params) is BallParams
        and all(type(getattr(ball.params, name)) in (float, np.float64)
                for name in _PARAMETERS)
        and type(ball.state.rvw) is np.ndarray
        and ball.state.rvw.dtype == np.float64 and ball.state.rvw.shape == (3, 3)
        and ball.state.s in (const.stationary, const.spinning, const.sliding,
                             const.rolling, const.pocketed)
        for ball in shot.balls.values()
    )


def _record_history(shot: System, event: Event) -> None:
    # BallState's generated attrs setter converts t to float on every assignment.
    # The exact concrete type is guarded by the online entry point. Convert the
    # same event time once, but preserve normal setters for any unexpected state.
    shot.t = event.time
    timestamp = float(event.time)
    for ball in shot.balls.values():
        state = ball.state
        if type(state) is BallState:
            object.__setattr__(state, "t", timestamp)
        else:
            state.t = event.time
        ball.history.add(state)
    shot.events.append(event)


class _OnlineSimulationState(_SimulationState):
    def __attrs_post_init__(self) -> None:
        # This private cache is owned by the online detector/simulator, never
        # installed in the public engine or supplied to unknown callers.
        from .ordered_cache import OnlineCollisionCache
        self.collision_cache = OnlineCollisionCache.create()
        self.transition_cache = TransitionCache.create(self.shot)

    def __init__(self, shot, engine, t_final=None, include=INCLUDED_EVENTS, max_events=0):
        super().__init__(shot, engine, t_final, include, max_events)
        self._balls = tuple(shot.balls.values())
        self._rvws = np.empty((len(self._balls), 3, 3), dtype=np.float64)
        self._states = np.empty(len(self._balls), dtype=np.int64)
        self._parameters = np.asarray([
            [getattr(ball.params, name) for name in _PARAMETERS]
            for ball in self._balls
        ], dtype=np.float64).reshape((-1, 6))

    def init(self) -> None:
        self.shot.reset_history()
        _record_history(self.shot, null_event(time=0))

    def evolve(self, shot: System, dt: float) -> None:
        for index, ball in enumerate(self._balls):
            state = ball.state
            self._rvws[index] = state.rvw
            self._states[index] = state.s
        outputs = _evolve_batch(self._rvws, self._states, self._parameters, dt)
        timestamp = shot.t + dt
        for ball, rvw in zip(self._balls, outputs):
            # Upstream intentionally ignores the kernel's returned motion state;
            # the separately selected transition event performs that change.
            ball.state = BallState(rvw, ball.state.s, timestamp)

    def step(self) -> Event:
        # Same control flow and strict limit comparisons as _SimulationState.
        # Only evolution dispatch and the local history writer differ.
        event = self.engine.detector.get_next_event(
            self.shot, transition_cache=self.transition_cache,
            collision_cache=self.collision_cache,
        )
        if event.time == np.inf:
            _record_history(self.shot, null_event(time=self.shot.t))
            self.done = True
            return event
        self.evolve(self.shot, event.time - self.shot.t)
        if event.event_type in self.include:
            self.engine.resolver.resolve(self.shot, event)
        _record_history(self.shot, event)
        if self.t_final is not None and self.shot.t >= self.t_final:
            _record_history(self.shot, null_event(time=self.shot.t))
            self.done = True
        if self.max_events > 0 and self.num_events > self.max_events:
            self.shot.stop_balls()
            _record_history(self.shot, null_event(time=self.shot.t))
            self.done = True
        self.num_events += 1
        return event


def simulate_online(shot: System, engine: SimulationEngine | None = None,
                    inplace: bool = False, continuous: bool = False,
                    dt: float | None = None, t_final: float | None = None,
                    include: set[EventType] = INCLUDED_EVENTS,
                    max_events: int = 0) -> System:
    """Stock simulator contract, optimized only for the known online 2D engine."""
    if not _supports_batch(shot, engine):
        return simulate(shot, engine=engine, inplace=inplace, continuous=continuous,
                        dt=dt, t_final=t_final, include=include, max_events=max_events)
    if not inplace:
        shot = shot.copy()
    simulation = _OnlineSimulationState(shot, engine, t_final, include, max_events)
    # These references are private to one synchronous, stock-resolver solve.
    # Direct detector/state callers keep their dynamic replacement semantics.
    if _fixed_layout(shot):
        simulation.collision_cache._online_fixed_layout = (tuple(shot.balls), simulation._balls)
    # Pruned future times are valid only while every normal transition/collision
    # still resolves and invalidates its affected cache rows. Custom include
    # filters keep the unpruned path, as do direct introspection state instances.
    simulation.collision_cache._online_prune_transitions = include == _PRUNING_EVENTS
    simulation.init()
    while not simulation.done:
        event = simulation.step()
        if not simulation.done:
            simulation.update_caches(event)
    if continuous:
        continuize(shot, dt=.01 if dt is None else dt, inplace=True)
    return shot
