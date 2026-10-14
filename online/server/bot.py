"""Server-side eight-ball bot built on pooltool's aiming and potting helpers.

The bot never bypasses the rules: it returns ordinary command payloads (an
optional cue-ball placement and a shot), which the server validates and
simulates exactly like a human player's commands.

Candidate pots come from ``pooltool.ai.pot`` geometry.  Stronger levels test
the best candidates with the real simulation and keep a shot that pots the
called ball without ending the turn; every level then adds aiming noise.
"""

from __future__ import annotations

import copy
import math
import random
import time
from typing import Any

import numpy as np

import pooltool as pt
from pooltool.ai.pot.core import (
    calc_cut_angle,
    calc_shadow_ball_center,
    get_potting_point,
    is_jaw_in_way,
    is_pocket_occluded,
    is_room_for_cue_ball,
)
from pooltool.ruleset.eight_ball import is_legal, is_turn_over

from .physics import ENGINE, MAX_EVENTS, PhysicsEngine, PhysicsError, _restore_game, _restore_system

LEVELS = {
    # noise: aim error in degrees; candidates/speeds: simulated search breadth.
    "easy": {"noise": 2.5, "candidates": 0, "speeds": (2.2,), "budget": 0.0},
    "medium": {"noise": 0.8, "candidates": 3, "speeds": (1.8, 2.8), "budget": 1.5},
    "hard": {"noise": 0.2, "candidates": 6, "speeds": (1.6, 2.4, 3.4), "budget": 3.0},
}


def _active_balls(system):
    return [ball for ball in system.balls.values() if ball.state.s != pt.constants.pocketed]


class _PotGeometry:
    """Cue-independent pot geometry, computed once per table position.

    Pocket occlusion, room for the cue ball and side-pocket jaws do not depend
    on where the cue ball is, so ball-in-hand search only re-checks the cue path.
    """

    def __init__(self, system, hittable):
        balls = _active_balls(system)
        self.R = system.balls["cue"].params.R
        self.obstacles = {b.id: b.xyz[:2].copy() for b in balls if b.id != "cue"}
        self.pots = []
        for ball_id in hittable:
            ball = system.balls.get(ball_id)
            if ball is None or ball.state.s == pt.constants.pocketed:
                continue
            for pocket in system.table.pockets.values():
                if (is_pocket_occluded(ball, system.table, pocket, balls)
                        or not is_room_for_cue_ball(ball, system.table, pocket, balls)
                        or is_jaw_in_way(ball, system.table, pocket)):
                    continue
                potting = np.asarray(get_potting_point(ball, system.table, pocket), dtype=float)
                ghost = np.asarray(calc_shadow_ball_center(ball, system.table, pocket), dtype=float)
                travel = float(np.linalg.norm(potting - ball.xyz[:2]))
                self.pots.append((ball_id, pocket.id, ghost, potting, travel))

    def _path_clear(self, start, end, ignore):
        segment = end - start
        length = float(segment @ segment)
        for ball_id, center in self.obstacles.items():
            if ball_id == ignore:
                continue
            s = 0.0 if length == 0 else float(np.clip((center - start) @ segment / length, 0.0, 1.0))
            if np.linalg.norm(start + s * segment - center) < 2 * self.R:
                return False
        return True

    def candidates(self, cue_xy, max_cut=75.0):
        """(score, ball_id, pocket_id, phi), easiest first."""
        result = []
        for ball_id, pocket_id, ghost, potting, travel in self.pots:
            cut = abs(calc_cut_angle(cue_xy, ghost, potting))
            if cut > max_cut or not self._path_clear(cue_xy, ghost, ball_id):
                continue
            aim = ghost - cue_xy
            # Thin cuts and long travel are what make pots miss.
            score = cut + 12.0 * (float(np.linalg.norm(aim)) + travel)
            result.append((score, ball_id, pocket_id, math.degrees(math.atan2(aim[1], aim[0]))))
        return sorted(result)


def _pot_candidates(system, hittable, max_cut=75.0):
    return _PotGeometry(system, hittable).candidates(system.balls["cue"].xyz[:2], max_cut)


def _nearest_pocket(system, ball_id):
    ball = system.balls[ball_id]
    return min(system.table.pockets.values(), key=lambda pocket: np.linalg.norm(pocket.center[:2] - ball.xyz[:2])).id


def _outcome(state, shot):
    """Simulate a candidate; return (pots_called_and_continues, legal)."""
    system = _restore_system(state)
    game = _restore_game(state)
    constraints = game.shot_constraints
    if constraints.call_shot:
        constraints.ball_call = shot["ballCall"]
        constraints.pocket_call = shot["pocketCall"]
    system.strike(V0=shot["V0"], phi=shot["phi"], theta=0.0, a=0.0, b=shot.get("b", 0.0))
    pt.simulate(system, engine=ENGINE, inplace=True, max_events=MAX_EVENTS, t_final=60.0)
    legal, _ = is_legal(system, constraints, state["rules"]["shotNumber"] == 0)
    continues = legal and not is_turn_over(system, constraints, legal)
    return continues, legal


def _shot(phi, speed, ball_id=None, pocket_id=None):
    shot = {"V0": round(float(speed), 3), "phi": round(float(phi) % 360, 4), "theta": 0.0, "a": 0.0, "b": 0.0}
    if ball_id is not None:
        shot.update(ballCall=str(ball_id), pocketCall=str(pocket_id))
    return shot


def _break_shot(state, system, rng, level):
    cue = system.balls["cue"]
    apex = min((b for b in _active_balls(system) if b.id != "cue"), key=lambda b: b.xyz[1])
    phi = math.degrees(math.atan2(apex.xyz[1] - cue.xyz[1], apex.xyz[0] - cue.xyz[0]))
    options = [_shot(phi + offset, speed) for speed in (6.5, 7.5) for offset in (0.0, 0.4, -0.4)]
    return _search(state, options, level["budget"]) or options[0]


def _search(state, options, budget):
    """First option that continues the turn, else the first legal one."""
    deadline = time.monotonic() + budget
    legal_option = None
    for option in options:
        if time.monotonic() > deadline:
            break
        try:
            continues, legal = _outcome(state, option)
        except Exception:
            continue
        if continues:
            return option
        if legal and legal_option is None:
            legal_option = option
    return legal_option


def _safety(state, system, hittable, rng, level):
    """No open pot: make legal contact with a target ball, preferring no foul."""
    cue = system.balls["cue"]
    targets = sorted((system.balls[b] for b in hittable if b in system.balls and system.balls[b].state.s != pt.constants.pocketed),
                     key=lambda b: np.linalg.norm(b.xyz[:2] - cue.xyz[:2]))
    options = []
    for ball in targets[:4]:
        phi = math.degrees(math.atan2(ball.xyz[1] - cue.xyz[1], ball.xyz[0] - cue.xyz[0]))
        for speed in (1.6, 2.6):
            options.append(_shot(phi, speed, ball.id, _nearest_pocket(system, ball.id)))
    if not options:
        raise PhysicsError("Нет допустимого удара для бота")
    return _search(state, options, max(level["budget"], 1.0)) or options[0]


def _choose_placement(state, rng):
    """Best ball-in-hand spot by the easiest pot it leaves (geometry only)."""
    rules = state["rules"]
    system = _restore_system(state)
    table = system.table
    radius = system.balls["cue"].params.R
    others = [b.xyz[:2] for b in _active_balls(system) if b.id != "cue"]
    pockets = [(p.center[:2], p.radius) for p in table.pockets.values()]
    max_y = table.l / 4 if rules["ballInHandRegion"] == "behind_line" else table.l - 3 * radius
    geometry = _PotGeometry(system, rules["hittable"])
    targets = [system.balls[b].xyz[:2] for b in rules["hittable"] if b in system.balls and system.balls[b].state.s != pt.constants.pocketed]
    scored = []
    # The server re-validates the chosen spot through place_cue_ball.
    for y in np.linspace(3 * radius, max_y, 14):
        for x in np.linspace(3 * radius, table.w - 3 * radius, 8):
            spot = np.array([x, y])
            if any(np.linalg.norm(spot - other) < 2 * radius + 1e-4 for other in others):
                continue
            if any(np.linalg.norm(spot - center) < r + radius for center, r in pockets):
                continue
            candidates = geometry.candidates(spot, max_cut=60.0)
            # Without an open pot, stay close to a target ball for a controlled safety.
            fallback = 1000.0 + min((float(np.linalg.norm(spot - t)) for t in targets), default=0.0)
            scored.append((candidates[0][0] if candidates else fallback, float(x), float(y)))
    for _, x, y in sorted(scored):
        try:
            return [round(x, 5), round(y, 5)], PhysicsEngine.place_cue_ball(state, x, y, shooter=rules["currentPlayer"])
        except PhysicsError:
            continue
    raise PhysicsError("Нет допустимой позиции для битка")


def decide(state: dict[str, Any], difficulty: str = "medium", seed: int | None = None) -> dict[str, Any]:
    """Return ``{"placement": [x, y] | None, "shot": payload}`` for the side to move."""
    level = LEVELS.get(difficulty, LEVELS["medium"])
    rng = random.Random(seed)
    rules = state["rules"]
    placement = None
    if rules.get("needsPlacement"):
        placement, state = _choose_placement(state, rng)
    system = _restore_system(state)
    if rules["shotNumber"] == 0:
        shot = _break_shot(state, system, rng, level)
    else:
        candidates = _pot_candidates(system, rules["hittable"])
        if not candidates:
            shot = _safety(state, system, rules["hittable"], rng, level)
        elif not level["candidates"]:
            _, ball_id, pocket_id, phi = candidates[0]
            shot = _shot(phi, level["speeds"][0] + rng.uniform(-0.4, 0.4), ball_id, pocket_id)
        else:
            options = [_shot(phi, speed, ball_id, pocket_id)
                       for _, ball_id, pocket_id, phi in candidates[:level["candidates"]] for speed in level["speeds"]]
            shot = _search(state, options, level["budget"]) or options[0]
    shot = copy.deepcopy(shot)
    shot["phi"] = round((shot["phi"] + rng.gauss(0, level["noise"])) % 360, 4)
    # The bot uses only the server's public shot parameters; the server re-validates.
    PhysicsEngine.validate_shot(state, shot, shooter=rules["currentPlayer"])
    return {"placement": placement, "shot": shot}
