import os
import time


def no_init():
    return None


def hanging_handler(context, state, shot, shooter):
    time.sleep(30)


def echo_handler(context, state, shot, shooter):
    if shot.get("hang"):
        time.sleep(30)
    if shot.get("reject"):
        raise ValueError("rejected")
    return {"state": state, "shooter": shooter, "pid": os.getpid()}
