import os
import time


def no_init():
    return None


def hanging_handler(context, op, state, shot, shooter):
    time.sleep(30)


def echo_handler(context, op, state, shot, shooter):
    if shot.get("hang"):
        time.sleep(30)
    if shot.get("reject"):
        raise ValueError("rejected")
    return {"op": op, "state": state, "shooter": shooter, "pid": os.getpid()}
