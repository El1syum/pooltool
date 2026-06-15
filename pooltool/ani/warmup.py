from __future__ import annotations

from pooltool.config import settings
from pooltool.evolution import simulate
from pooltool.layouts import get_rack
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


def _warmup_game_break() -> System:
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


def warmup_shot_simulation() -> None:
    """Compile the hot shot-simulation path before the player takes a shot."""
    global _physics_warmed_up

    if _physics_warmed_up:
        return

    for system in (_warmup_example_shot(), _warmup_game_break()):
        simulate(
            system,
            continuous=True,
            dt=settings.system.shot_animation_dt,
            inplace=True,
            max_events=160,
        )

    _physics_warmed_up = True
