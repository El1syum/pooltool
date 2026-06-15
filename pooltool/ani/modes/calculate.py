#! /usr/bin/env python

from time import perf_counter

import pooltool.ani.tasks as tasks
import pooltool.ani.utils as autils
from pooltool.ani.action import Action
from pooltool.ani.camera import cam
from pooltool.ani.constants import rotate_downtime
from pooltool.ani.globals import Global
from pooltool.ani.modes.datatypes import BaseMode, Mode
from pooltool.ani.mouse import MouseMode, mouse
from pooltool.config import settings
from pooltool.evolution import continuize, simulate
from pooltool.system.datatypes import System, multisystem


class CalculateMode(BaseMode):
    name = Mode.calculate
    keymap = {
        Action.move: False,
        Action.quit: False,
        Action.zoom: False,
        Action.show_help: False,
    }

    def enter(self):
        mouse.mode(MouseMode.RELATIVE)

        self.shot_sim_overlay = autils.TextOverlay(
            title="Calculating shot...",
            frame_color=(0, 0, 0, 0.4),
            title_pos=(0, 0, -0.2),
        )

        tasks.add(
            self.run_simulation,
            "run_simulation",
            extraArgs=[multisystem.active],
            taskChain="simulation",
            appendTask=True,
        )

        self.register_keymap_event("escape", Action.quit, True)
        self.register_keymap_event("mouse1", Action.zoom, True)
        self.register_keymap_event("mouse1-up", Action.zoom, False)
        self.register_keymap_event("a", Action.aim, True)
        self.register_keymap_event("v", Action.move, True)
        self.register_keymap_event("v-up", Action.move, False)
        self.register_keymap_event("h", Action.show_help, True)

        tasks.add(self.calculate_view_task, "calculate_view_task")
        tasks.add(self.shared_task, "shared_task")

    def exit(self):
        tasks.remove("calculate_view_task")
        tasks.remove("shared_task")

        self.shot_sim_overlay.hide()

    def calculate_view_task(self, task):
        if not tasks.has("run_simulation"):
            # simulation calculation is finished
            Global.mode_mgr.change_mode(
                Mode.shot, enter_kwargs=dict(build_animations=True)
            )
        elif self.keymap[Action.zoom]:
            cam.zoom_via_mouse()
        elif self.keymap[Action.move]:
            cam.move_fixation_via_mouse()
        else:
            if task.time < rotate_downtime:
                # This catch helps prevent the shot follow through from moving the
                # camera, which is annoying and no one would want. So instead of
                # rotating the camera, we just touch the mouse so there is not a big
                # jump the next time the camera is truly rotated
                mouse.touch()
            else:
                cam.rotate_via_mouse()

            if task.time > 0.25:
                self.shot_sim_overlay.show()

        return task.cont

    def run_simulation(self, system: System, task):
        """Run a pool simulation"""

        started_at = perf_counter()
        simulate(
            system,
            continuous=False,
            inplace=True,
            max_events=settings.system.shot_max_events,
        )
        simulated_at = perf_counter()
        continuize(
            system,
            dt=settings.system.shot_animation_dt,
            inplace=True,
        )
        continuized_at = perf_counter()

        samples = sum(len(ball.history_cts) for ball in system.balls.values())
        print(
            "[pooltool-cyberpool] shot calculation "
            f"events={len(system.events)} samples={samples} "
            f"simulate={simulated_at - started_at:.3f}s "
            f"continuize={continuized_at - simulated_at:.3f}s "
            f"total={continuized_at - started_at:.3f}s"
        )

        tasks.remove("run_simulation")

        return task.done
