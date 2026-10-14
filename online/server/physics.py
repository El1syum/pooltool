"""Authoritative, display-free pooltool physics for two-player eight-ball.

The engine accepts and returns JSON-serializable state.  Match state belongs to
the server: clients send cue parameters, never ball positions or adjudication.
This module is synchronous so the API can run it in an isolated worker with a
wall-clock timeout.  Simulation limits fail explicitly rather than accepting a
truncated or fabricated result.
"""

from __future__ import annotations

import copy
import math
import random
from collections import Counter
from typing import Any

import numpy as np

import pooltool as pt
from pooltool.evolution.engine import SimulationEngine
from pooltool.objects.ball.datatypes import BallState
from pooltool.physics.resolve.resolver import default_resolver
from pooltool.ruleset.datatypes import BallInHandOptions, ShotConstraints, ShotInfo
from pooltool.ruleset.eight_ball import BallGroup, is_legal

STATE_VERSION = 1
MAX_EVENTS = 10000
MAX_DURATION = 60.0
PLAYBACK_DT = 1 / 60
POCKET_ALIASES = {"1": "lb", "2": "lc", "3": "lt", "4": "rt", "5": "rc", "6": "rb"}
ENGINE = SimulationEngine(resolver=default_resolver())


class PhysicsError(ValueError):
    """A rejected command or an incomplete physics calculation."""


def _finite(value: Any, name: str) -> float:
    if isinstance(value, bool):
        raise PhysicsError(f"{name}: требуется конечное число")
    try:
        value = float(value)
    except (TypeError, ValueError):
        raise PhysicsError(f"{name}: требуется конечное число") from None
    if not math.isfinite(value):
        raise PhysicsError(f"{name}: требуется конечное число")
    return value


def _vec(values: Any) -> list[float]:
    return [round(float(value), 9) for value in values]


def _quaternion_step(q: list[float], angular_velocity: Any, dt: float) -> list[float]:
    """Integrate world angular velocity; return Three.js [x,y,z,w]."""
    omega = np.asarray(angular_velocity, dtype=float)
    speed = float(np.linalg.norm(omega))
    if speed < 1e-10 or dt <= 0:
        return q
    half_angle = speed * dt / 2
    axis = omega / speed * math.sin(half_angle)
    x, y, z, w = q
    dx, dy, dz = axis
    dw = math.cos(half_angle)
    result = np.array([
        dw * x + dx * w + dy * z - dz * y,
        dw * y - dx * z + dy * w + dz * x,
        dw * z + dx * y - dy * x + dz * w,
        dw * w - dx * x - dy * y - dz * z,
    ])
    result /= np.linalg.norm(result)
    return _vec(result)


def _serialize_constraints(constraints: ShotConstraints) -> dict[str, Any]:
    return {
        "ballInHandRegion": str(constraints.ball_in_hand),
        "movable": constraints.movable,
        "cueable": constraints.cueable,
        "hittable": list(constraints.hittable),
        "callShotRequired": constraints.call_shot,
    }


def _restore_game(state: dict[str, Any]):
    data = state["rules"]
    game = pt.get_ruleset(pt.GameType.EIGHTBALL)(
        [pt.Player("player0"), pt.Player("player1")]
    )
    game.active_idx = int(data["currentPlayer"])
    game.shot_number = int(data["shotNumber"])
    game.turn_number = int(data["turnNumber"])
    game.score = Counter(data.get("score", {}))
    game.shot_constraints = ShotConstraints(
        ball_in_hand=BallInHandOptions(data["ballInHandRegion"]),
        movable=data.get("movable", []),
        cueable=["cue"],
        hittable=tuple(data["hittable"]),
        call_shot=bool(data["callShotRequired"]),
    )
    return game


def _restore_system(state: dict[str, Any]):
    if state.get("version") != STATE_VERSION:
        raise PhysicsError("Неподдерживаемая версия состояния матча")
    table = pt.Table.from_game_type(pt.GameType.EIGHTBALL)
    balls = {}
    for ball_id, data in state["system"]["balls"].items():
        ball = pt.Ball.create(ball_id, xy=data["rvw"][0][:2])
        ball.state = BallState(np.asarray(data["rvw"], dtype=np.float64), int(data["s"]))
        if not np.isfinite(ball.state.rvw).all():
            raise PhysicsError("Состояние матча содержит некорректные координаты")
        balls[ball_id] = ball
    for pocket_id, contains in state["system"].get("pockets", {}).items():
        table.pockets[pocket_id].contains.clear()
        table.pockets[pocket_id].contains.update(contains)
    return pt.System(table=table, balls=balls, cue=pt.Cue.default())


def _pack_system(system: Any, quaternions: dict[str, list[float]]) -> dict[str, Any]:
    return {
        "balls": {
            ball_id: {
                "rvw": [_vec(row) for row in ball.state.rvw],
                "s": int(ball.state.s),
                "quaternion": quaternions.get(ball_id, [0.0, 0.0, 0.0, 1.0]),
            }
            for ball_id, ball in system.balls.items()
        },
        "pockets": {
            pocket_id: sorted(pocket.contains)
            for pocket_id, pocket in system.table.pockets.items()
        },
    }


def _ball_view(ball: Any, quaternion: list[float], state: Any = None) -> dict[str, Any]:
    state = ball.state if state is None else state
    position = _vec(state.rvw[0])
    return {
        "id": ball.id,
        "position": position,
        "x": position[0],
        "y": position[1],
        "z": position[2],
        "radius": float(ball.params.R),
        "state": int(state.s),
        "pocketed": int(state.s) == pt.constants.pocketed,
        "quaternion": quaternion,
    }


def _ensure_safe_cue_respot(system: Any) -> None:
    """Complete upstream's respot operation, which does not test overlap."""
    cue = system.balls["cue"]
    radius = cue.params.R

    def available(x: float, y: float) -> bool:
        return all(
            ball.id == "cue" or ball.state.s == pt.constants.pocketed
            or math.hypot(x - ball.xyz[0], y - ball.xyz[1]) >= radius + ball.params.R + 1e-5
            for ball in system.balls.values()
        ) and all(
            math.hypot(x - pocket.center[0], y - pocket.center[1]) >= pocket.radius + radius
            for pocket in system.table.pockets.values()
        )

    if not available(float(cue.xyz[0]), float(cue.xyz[1])):
        candidates = (
            (float(x), float(y))
            for y in np.linspace(radius * 3, system.table.l - radius * 3, 32)
            for x in np.linspace(radius * 3, system.table.w - radius * 3, 16)
        )
        for x, y in candidates:
            if available(x, y):
                cue.state.rvw[0] = [x, y, radius]
                break
        else:
            raise PhysicsError("Не найдено свободное место для битка")
    cue.state.rvw[1:] = 0
    cue.state.s = pt.constants.stationary
    for pocket in system.table.pockets.values():
        pocket.contains.discard("cue")


def _event_view(event: Any, index: int) -> dict[str, Any]:
    def ball_states(which: str) -> dict[str, Any]:
        states = {}
        for agent in event.agents:
            obj = getattr(agent, which)
            if isinstance(obj, pt.Ball):
                states[obj.id] = {
                    "position": _vec(obj.state.rvw[0]),
                    "velocity": _vec(obj.state.rvw[1]),
                    "angularVelocity": _vec(obj.state.rvw[2]),
                    "state": int(obj.state.s),
                }
        return states
    return {
        "id": f"event_{index}",
        "type": str(event.event_type),
        "time": round(float(event.time), 9),
        "ids": list(event.ids),
        "initial": ball_states("initial"),
        "final": ball_states("final"),
    }


class PhysicsEngine:
    """Pure match operations backed by the actual pooltool simulation."""

    @staticmethod
    def warmup() -> None:
        """Compile the collision path once in each simulation worker."""
        system = pt.System.example()
        system.strike(V0=2.0, phi=95.0, theta=0.0, a=0.0, b=0.0)
        pt.simulate(system, engine=ENGINE, inplace=True, max_events=MAX_EVENTS)
        pt.continuize(system, dt=PLAYBACK_DT, inplace=True)

    @staticmethod
    def new_match(seed: int | None = None) -> dict[str, Any]:
        if seed is None:
            seed = random.SystemRandom().randrange(2**32)
        seed = int(seed) % 2**32
        py_random, np_random = random.getstate(), np.random.get_state()
        try:
            random.seed(seed)
            np.random.seed(seed)
            table = pt.Table.from_game_type(pt.GameType.EIGHTBALL)
            balls = pt.get_rack(pt.GameType.EIGHTBALL, table)
        finally:
            random.setstate(py_random)
            np.random.set_state(np_random)
        system = pt.System(table=table, balls=balls, cue=pt.Cue.default())
        game = pt.get_ruleset(pt.GameType.EIGHTBALL)(
            [pt.Player("player0"), pt.Player("player1")]
        )
        state = {
            "version": STATE_VERSION,
            "engineVersion": pt.__version__,
            "seed": seed,
            "system": _pack_system(system, {}),
            "rules": {
                "currentPlayer": 0,
                "shotNumber": 0,
                "turnNumber": 0,
                "groups": [None, None],
                "score": {},
                "winner": None,
                "foul": False,
                "foulReason": "",
                "needsPlacement": False,
                **_serialize_constraints(game.shot_constraints),
            },
        }
        state["snapshot"] = PhysicsEngine.snapshot(state)
        return state

    @staticmethod
    def snapshot(state: dict[str, Any]) -> dict[str, Any]:
        system = _restore_system(state)
        rules = state["rules"]
        return {
            "balls": [
                _ball_view(ball, state["system"]["balls"][ball.id]["quaternion"])
                for ball in sorted(system.balls.values(), key=lambda b: (b.id != "cue", int(b.id) if b.id != "cue" else 0))
            ],
            "table": {
                "width": float(system.table.w),
                "length": float(system.table.l),
                "height": float(system.table.height),
                "renderHeight": float(system.table.height),
                "cushionHeight": float(next(iter(system.table.cushion_segments.linear.values())).height),
                "pockets": [
                    {"id": key, "position": _vec(p.center), "center": _vec(p.center), "radius": float(p.radius)}
                    for key, p in system.table.pockets.items()
                ],
            },
            "cueBallId": "cue",
            "groups": list(rules["groups"]),
            "currentPlayer": rules["currentPlayer"],
            "nextPlayer": rules["currentPlayer"],
            "ballInHand": rules["ballInHandRegion"] != str(BallInHandOptions.NONE),
            "ballInHandRegion": rules["ballInHandRegion"],
            "needsPlacement": rules.get("needsPlacement", False),
            "winner": rules["winner"],
            "callShotRequired": rules["callShotRequired"],
            "hittable": list(rules["hittable"]),
            "shotNumber": rules["shotNumber"],
            "foul": rules.get("foul", False),
            "foulReason": rules.get("foulReason", ""),
        }

    @staticmethod
    def _assert_turn(state: dict[str, Any], shooter: int) -> None:
        if state["rules"]["winner"] is not None:
            raise PhysicsError("Матч уже завершён")
        if shooter not in (0, 1) or shooter != state["rules"]["currentPlayer"]:
            raise PhysicsError("Сейчас ход другого игрока")

    @staticmethod
    def validate_shot(state: dict[str, Any], shot: dict[str, Any], shooter: int = 0) -> dict[str, float]:
        PhysicsEngine._assert_turn(state, shooter)
        if state["rules"].get("needsPlacement", False):
            raise PhysicsError("Перед ударом установите биток")
        values = {name: _finite(shot.get(name, default), name) for name, default in {"V0": 2.0, "phi": 90.0, "theta": 0.0, "a": 0.0, "b": 0.0}.items()}
        if not 0.05 <= values["V0"] <= 8.0:
            raise PhysicsError("Сила удара должна быть от 0,05 до 8 м/с")
        if not 0 <= values["theta"] <= 60:
            raise PhysicsError("Наклон кия должен быть от 0 до 60 градусов")
        if values["a"] ** 2 + values["b"] ** 2 > 0.9 ** 2 + 1e-12:
            raise PhysicsError("Точка удара должна быть в пределах 90% радиуса битка")
        values["phi"] %= 360
        if shot.get("cueBallId", "cue") != "cue":
            raise PhysicsError("Бить можно только битком")
        if state["system"]["balls"]["cue"]["s"] == pt.constants.pocketed:
            raise PhysicsError("Перед ударом установите биток")
        constraints = state["rules"]
        if constraints["callShotRequired"]:
            ball_call = str(shot.get("ballCall") or shot.get("ball_call") or "")
            pocket_call = str(shot.get("pocketCall") or shot.get("pocket_call") or "")
            if ball_call not in constraints["hittable"]:
                raise PhysicsError("Перед ударом закажите шар своей группы")
            if state["system"]["balls"][ball_call]["s"] == pt.constants.pocketed:
                raise PhysicsError("Нельзя заказать уже забитый шар")
            pocket_call = POCKET_ALIASES.get(pocket_call, pocket_call)
            if pocket_call not in ("lb", "lc", "lt", "rb", "rc", "rt"):
                raise PhysicsError("Перед ударом закажите одну из шести луз")
        return values

    @staticmethod
    def simulate(state: dict[str, Any], shot: dict[str, Any], shooter: int = 0) -> dict[str, Any]:
        values = PhysicsEngine.validate_shot(state, shot, shooter)
        initial = PhysicsEngine.snapshot(state)
        system = _restore_system(state)
        game = _restore_game(state)
        if game.shot_constraints.call_shot:
            game.shot_constraints.ball_call = str(shot.get("ballCall") or shot.get("ball_call"))
            pocket = str(shot.get("pocketCall") or shot.get("pocket_call"))
            game.shot_constraints.pocket_call = POCKET_ALIASES.get(pocket, pocket)
        system.strike(**values)
        pt.simulate(system, engine=ENGINE, inplace=True, max_events=MAX_EVENTS, t_final=MAX_DURATION)
        if len(system.events) >= MAX_EVENTS or system.t >= MAX_DURATION:
            raise PhysicsError("Симуляция превысила лимит событий или длительности")
        if any(ball.state.s not in (pt.constants.stationary, pt.constants.pocketed) for ball in system.balls.values()):
            raise PhysicsError("Симуляция не завершилась остановкой шаров")
        pt.continuize(system, dt=PLAYBACK_DT, inplace=True)
        quaternions = {key: list(data["quaternion"]) for key, data in state["system"]["balls"].items()}
        trajectory = PhysicsEngine._trajectory(system, quaternions)
        events = [
            _event_view(event, index)
            for index, event in enumerate(system.events)
        ]
        # Playback needs event timing/type for sounds; telemetry retains the
        # complete before/after vectors in the separate events collection.
        trajectory["events"] = [
            {key: event[key] for key in ("type", "time", "ids")}
            for event in events
        ]
        potted = [
            {"ball": e["ids"][0], "pocket": e["ids"][1], "time": e["time"], "order": index + 1}
            for index, e in enumerate(e for e in events if e["type"] == "ball_pocket")
        ]
        # Upstream eight-ball's get_score reads self.shot_info.legal while
        # build_shot_info is still building that very object.  Seed it with this
        # shot's actual legality, so restored games and the winning eight shot
        # do not depend on a missing or stale previous ShotInfo.
        legal, reason = is_legal(system, game.shot_constraints, game.shot_number == 0)
        game.shot_info = ShotInfo(
            player=game.active_player, legal=legal, reason=reason,
            turn_over=False, game_over=False, winner=None, score=game.score,
        )
        game.process_and_advance(system)
        info = game.shot_info
        if not info.legal:
            _ensure_safe_cue_respot(system)
        groups = list(state["rules"]["groups"])
        if groups[0] is None and info.legal and not info.turn_over and state["rules"]["callShotRequired"]:
            called = str(shot.get("ballCall") or shot.get("ball_call"))
            assigned = BallGroup.SOLIDS if called in BallGroup.SOLIDS.balls else BallGroup.STRIPES
            groups[shooter] = str(assigned)
            groups[1 - shooter] = str(BallGroup.STRIPES if assigned == BallGroup.SOLIDS else BallGroup.SOLIDS)
        winner = None if info.winner is None else int(info.winner.name[-1])
        next_state = {
            "version": STATE_VERSION,
            "engineVersion": pt.__version__,
            "seed": state["seed"],
            "system": _pack_system(system, quaternions),
            "rules": {
                "currentPlayer": game.active_idx,
                "shotNumber": state["rules"]["shotNumber"] + 1,
                "turnNumber": game.turn_number,
                "groups": groups,
                "score": dict(game.score),
                "winner": winner,
                "foul": not info.legal,
                "foulReason": info.reason,
                "needsPlacement": not info.legal and winner is None,
                **_serialize_constraints(game.shot_constraints),
            },
        }
        next_state["snapshot"] = PhysicsEngine.snapshot(next_state)
        outcome = {
            **next_state["snapshot"],
            "nextPlayer": game.active_idx,
            "turnOver": info.turn_over,
            "legal": info.legal,
            "gameOver": info.game_over,
            "score": dict(game.score),
        }
        return {
            "state": next_state,
            "initialState": initial,
            "finalState": next_state["snapshot"],
            "trajectory": trajectory,
            "trajectories": trajectory,
            "events": events,
            "potted": potted,
            "duration": trajectory["duration"],
            "rules": outcome,
            "strike": values,
        }

    @staticmethod
    def _trajectory(system: Any, quaternions: dict[str, list[float]]) -> dict[str, Any]:
        """Delta-encoded playback: a frame lists only balls whose visible state changed.

        Each entry is ``[id, x, y, z, state, qx, qy, qz, qw]``; the client expands
        it back into full frames (see ``expandTrajectory`` in the web client).

        Positions are rounded to 0.01 mm and quaternions to 1e-4, far below what
        a rendered frame can show; resting balls are not repeated every 1/60 s.
        """
        balls = sorted(system.balls.values(), key=lambda ball: ball.id)
        frames = []
        last_time = 0.0
        emitted: dict[str, tuple] = {}
        for index in range(len(balls[0].history_cts)):
            timestamp = float(balls[0].history_cts[index].t)
            frame_balls = []
            for ball in balls:
                current = ball.history_cts[index]
                if index:
                    previous = ball.history_cts[index - 1]
                    omega = (previous.rvw[2] + current.rvw[2]) / 2
                    quaternions[ball.id] = _quaternion_step(quaternions[ball.id], omega, timestamp - last_time)
                position = [round(float(value), 5) for value in current.rvw[0]]
                quaternion = [round(float(value), 4) for value in quaternions[ball.id]]
                key = (tuple(position), tuple(quaternion), int(current.s))
                if emitted.get(ball.id) != key:
                    emitted[ball.id] = key
                    frame_balls.append([ball.id, *position, int(current.s), *quaternion])
            frames.append({"t": round(timestamp, 5), "balls": frame_balls})
            last_time = timestamp
        return {"duration": round(float(system.t), 9), "dt": PLAYBACK_DT, "encoding": "delta", "frames": frames}

    @staticmethod
    def place_cue_ball(state: dict[str, Any], x: float, y: float, shooter: int = 0) -> dict[str, Any]:
        PhysicsEngine._assert_turn(state, shooter)
        region = state["rules"]["ballInHandRegion"]
        if region == str(BallInHandOptions.NONE):
            raise PhysicsError("В этот ход переставлять биток нельзя")
        x, y = _finite(x, "x"), _finite(y, "y")
        system = _restore_system(state)
        cue = system.balls["cue"]
        radius = cue.params.R
        if not radius <= x <= system.table.w - radius or not radius <= y <= system.table.l - radius:
            raise PhysicsError("Биток должен находиться на игровом поле")
        if region == str(BallInHandOptions.BEHIND_LINE) and y > system.table.l / 4:
            raise PhysicsError("При разбое биток ставится за линией дома")
        for ball in system.balls.values():
            if ball.id == "cue" or ball.state.s == pt.constants.pocketed:
                continue
            if math.hypot(x - ball.xyz[0], y - ball.xyz[1]) < radius + ball.params.R + 1e-5:
                raise PhysicsError("Биток пересекается с другим шаром")
        for pocket in system.table.pockets.values():
            if math.hypot(x - pocket.center[0], y - pocket.center[1]) < pocket.radius + radius:
                raise PhysicsError("Биток нельзя поставить в створ лузы")
        next_state = copy.deepcopy(state)
        next_state["system"]["balls"]["cue"]["rvw"] = [[x, y, radius], [0.0] * 3, [0.0] * 3]
        next_state["system"]["balls"]["cue"]["s"] = pt.constants.stationary
        next_state["rules"]["needsPlacement"] = False
        for contains in next_state["system"]["pockets"].values():
            if "cue" in contains:
                contains.remove("cue")
        next_state["snapshot"] = PhysicsEngine.snapshot(next_state)
        return next_state

    @staticmethod
    def timeout(state: dict[str, Any], shooter: int = 0) -> dict[str, Any]:
        PhysicsEngine._assert_turn(state, shooter)
        next_state = copy.deepcopy(state)
        rules = next_state["rules"]
        rules["currentPlayer"] = 1 - shooter
        rules["turnNumber"] += 1
        rules["shotNumber"] += 1
        rules["foul"] = True
        rules["foulReason"] = "Shot clock expired"
        rules["needsPlacement"] = True
        rules["ballInHandRegion"] = str(BallInHandOptions.ANYWHERE)
        rules["movable"] = ["cue"]
        rules["callShotRequired"] = True
        target = rules["groups"][1 - shooter]
        group = BallGroup.UNDECIDED if target is None else BallGroup(target)
        balls = next_state["system"]["balls"]
        if group in (BallGroup.SOLIDS, BallGroup.STRIPES) and all(balls[key]["s"] == pt.constants.pocketed for key in group.balls):
            group = BallGroup.EIGHT
        rules["hittable"] = list(group.balls)
        next_state["snapshot"] = PhysicsEngine.snapshot(next_state)
        return next_state
