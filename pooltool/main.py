#!/usr/bin/env python


import attrs
import click

from pooltool.ani.animate import Game, ShowBaseConfig
from pooltool.config import apply_runtime_window_settings


@click.command()
@click.option("--monitor", is_flag=True, help="Spit out per-frame info about game")
@click.option(
    "--window-mode",
    type=click.Choice(["windowed", "fullscreen", "borderless"], case_sensitive=False),
    envvar="POOLTOOL_WINDOW_MODE",
    help="Window mode. Can also be set with POOLTOOL_WINDOW_MODE.",
)
@click.option(
    "--window-size",
    envvar="POOLTOOL_WINDOW_SIZE",
    help="Window size: fullhd, 2k, or WIDTHxHEIGHT. Can also be set with POOLTOOL_WINDOW_SIZE.",
)
@click.option(
    "--warmup/--no-warmup",
    default=None,
    envvar="POOLTOOL_WARMUP_PHYSICS",
    help="Warm up shot physics before the first playable shot.",
)
def run(monitor, window_mode, window_size, warmup):
    system_config = apply_runtime_window_settings(
        window_mode=window_mode,
        window_size=window_size,
        window_title="Cyberpool Pooltool",
    )

    if warmup is None:
        warmup = True

    config = attrs.evolve(
        ShowBaseConfig.default(),
        monitor=monitor,
        window_size=(system_config.window_width, system_config.window_height),
        warmup_physics=bool(warmup),
    )

    play = Game(config)
    play.start()


if __name__ == "__main__":
    run()
