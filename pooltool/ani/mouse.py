#! /usr/bin/env python

import numpy as np
from panda3d.core import ClockObject, WindowProperties

from pooltool.ani.globals import Global, require_showbase
from pooltool.utils.strenum import StrEnum, auto


class MouseMode(StrEnum):
    ABSOLUTE = auto()
    RELATIVE = auto()


class Mouse(ClockObject):
    def __init__(self):
        ClockObject.__init__(self)
        self.relative_requested = False
        self.initialized = False
        self.centered_relative = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.touch()

    def mode(self, mouse_mode: MouseMode) -> None:
        """Change to different mouse mode (silently return if mouse uninitialized)"""
        if not self.initialized:
            return

        if mouse_mode == MouseMode.ABSOLUTE:
            self.show()
            self.absolute()
        elif mouse_mode == MouseMode.RELATIVE:
            mouse.hide()
            mouse.relative()

        mouse.track()

    @require_showbase
    def init(self):
        Global.base.disableMouse()
        self.mouse = Global.base.mouseWatcherNode
        self.touch()
        self.initialized = True

    def hide(self):
        props = WindowProperties()
        props.setCursorHidden(True)
        Global.base.win.requestProperties(props)

    def show(self):
        props = WindowProperties()
        props.setCursorHidden(False)
        Global.base.win.requestProperties(props)

    def absolute(self):
        props = WindowProperties()
        props.setMouseMode(WindowProperties.M_absolute)
        Global.base.win.requestProperties(props)
        self.centered_relative = False

        if self.relative_requested:
            self.relative_requested = False

    def relative(self):
        if self.mouse.hasMouse():
            props = WindowProperties()
            props.setMouseMode(WindowProperties.M_confined)
            props.setCursorHidden(True)
            Global.base.win.requestProperties(props)
            self.centered_relative = True
            self.relative_requested = False
            self.center()
        else:
            self.relative_requested = True

    def center(self):
        if not self.centered_relative:
            return

        x = max(Global.base.win.getXSize() // 2, 0)
        y = max(Global.base.win.getYSize() // 2, 0)
        Global.base.win.movePointer(0, x, y)

    def touch(self):
        if self.relative_requested:
            self.relative()

        if self.centered_relative:
            self.center()
            self.last_x, self.last_y = 0, 0
        else:
            self.last_x, self.last_y = self.get_xy()
        self.last_t = self.getRealTime() - self.getDt()

    def track(self):
        if self.mouse.hasMouse():
            self.touch()

    def get_x(self):
        return self.mouse.getMouseX() if self.mouse.hasMouse() else 0

    def get_y(self):
        return self.mouse.getMouseY() if self.mouse.hasMouse() else 0

    def get_xy(self):
        return self.get_x(), self.get_y()

    def get_dx(self):
        return self.get_x() - self.last_x

    def get_dy(self):
        return self.get_y() - self.last_y

    def get_vel_x(self):
        dt = self.get_dt()

        if not dt:
            return np.inf

        return self.get_dx() / dt

    def get_vel_y(self):
        dt = self.get_dt()

        if not dt:
            return np.inf

        return self.get_dy() / dt

    def get_dt(self):
        return self.getRealTime() - self.last_t


mouse = Mouse()
