import time


def hanging_worker(pipe, state, shot, shooter):
    time.sleep(30)


def echo_worker(pipe, state, shot, shooter):
    pipe.send(("ok", {"state": state, "shooter": shooter}))
    pipe.close()
