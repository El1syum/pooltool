from __future__ import annotations

from pooltool.config import settings
from pooltool.evolution import simulate
from pooltool.game.datatypes import GameType
from pooltool.layouts import get_rack
from pooltool.objects import Ball
from pooltool.objects.cue.datatypes import Cue
from pooltool.objects.table.collection import prebuilt_specs
from pooltool.objects.table.datatypes import Table
from pooltool.ruleset import get_ruleset
from pooltool.system.datatypes import System

_physics_warmed_up = False


def _warmup_example_shot() -> System:
    system = System.example()
    system.strike(V0=1.2, phi=0.0, theta=0.0, a=0.0, b=0.0)
    return system


def _warmup_game_break(game_type=None) -> System:
    if game_type is None:
        game_type = settings.gameplay.game_type

    game = get_ruleset(game_type, enforce_rules=settings.gameplay.enforce_rules)()
    table = Table.from_table_specs(prebuilt_specs(settings.gameplay.table_name))
    balls = get_rack(
        game_type=game_type,
        table=table,
        ball_params=None,
        ballset=None,
        spacing_factor=1e-3,
    )
    cue = Cue.from_game_type(game_type)
    cue.cue_ball_id = game.shot_constraints.cueball(balls)
    system = System(table=table, balls=balls, cue=cue)
    system.strike(V0=2.6, phi=90.0, theta=0.0, a=0.0, b=0.0)
    return system


def _warmup_agent_eightball_shot(**cue_state) -> System:
    table = Table.from_game_type(GameType.EIGHTBALL)
    balls = get_rack(GameType.EIGHTBALL, table)
    balls["cue"] = Ball.create("cue", xy=(table.w / 2, table.l * 0.25))
    system = System(cue=Cue(cue_ball_id="cue"), table=table, balls=balls)
    system.strike(**cue_state)
    return system


def warmup_shot_simulation() -> None:
    """Compile the hot shot-simulation path before the player takes a shot."""
    global _physics_warmed_up

    if _physics_warmed_up:
        return

    systems = (
        _warmup_example_shot(),
        _warmup_game_break(),
        _warmup_game_break(GameType.EIGHTBALL),
        _warmup_agent_eightball_shot(V0=2.5, phi=95, theta=0, a=0, b=0),
        _warmup_agent_eightball_shot(V0=2.8, phi=95, theta=5, a=0, b=0),
        _warmup_agent_eightball_shot(V0=2.5, phi=95, theta=0, a=0.2, b=0),
        _warmup_agent_eightball_shot(V0=2.5, phi=95, theta=0, a=0, b=0.2),
    )

    for system in systems:
        simulate(
            system,
            continuous=True,
            dt=settings.system.shot_animation_dt,
            inplace=True,
            max_events=settings.system.shot_max_events,
        )

    _physics_warmed_up = True
