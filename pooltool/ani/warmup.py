from __future__ import annotations

from pooltool.evolution import simulate
from pooltool.system.datatypes import System

_physics_warmed_up = False


def warmup_shot_simulation() -> None:
    """Compile the hot shot-simulation path before the player takes a shot."""
    global _physics_warmed_up

    if _physics_warmed_up:
        return

    system = System.example()
    system.strike(V0=1.2, phi=0.0, theta=0.0, a=0.0, b=0.0)
    simulate(system, continuous=True, inplace=True, max_events=80)

    _physics_warmed_up = True
