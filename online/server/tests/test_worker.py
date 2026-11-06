import asyncio
import time

from online.server.tests.worker_fixtures import echo_handler, no_init
from online.server.worker import PhysicsWorkers


def test_extended_warmup_covers_follow_and_elevated_english():
    from online.server.worker import _warm_full_path

    class Engine:
        def __init__(self):
            self.shots = []

        def new_match(self, seed):
            return {"system": {"balls": {"cue": {"rvw": [[0.5, 0.5, 0.03]]}}},
                    "snapshot": {"table": {"width": 1.0, "length": 2.0}},
                    "rules": {"winner": 0}}

        def simulate(self, state, shot, shooter):
            self.shots.append(shot)
            return {"state": state}

    engine = Engine()
    _warm_full_path(engine)
    assert len(engine.shots) == 3
    assert any(shot.get("b", 0) == 0.8 and shot["V0"] == 8 for shot in engine.shots)
    assert any(shot.get("a", 0) == -0.3 and shot.get("theta") == 5 for shot in engine.shots)


def test_warm_worker_is_reused_and_a_stalled_one_is_killed_and_replaced():
    async def scenario():
        workers = PhysicsWorkers(size=1, handler=echo_handler, initializer=no_init)
        try:
            assert workers.warm_count == 0
            first = await workers.calculate({"valid": True}, {}, 1, timeout=60)
            assert workers.warm_count == 1
            assert first["state"] == {"valid": True} and first["shooter"] == 1
            # The same warm process serves the next shot: no per-shot process startup.
            started = time.monotonic()
            second = await workers.calculate({}, {}, 0, timeout=5)
            assert second["pid"] == first["pid"]
            assert time.monotonic() - started < 0.5
            try:
                await workers.calculate({}, {"reject": True}, 0, timeout=5)
            except ValueError:
                pass
            else:
                raise AssertionError("Rejected shot was accepted")
            # A rejected shot keeps the worker healthy.
            assert (await workers.calculate({}, {}, 0, timeout=5))["pid"] == first["pid"]
            started = time.monotonic()
            try:
                await workers.calculate({}, {"hang": True}, 0, timeout=0.3)
            except asyncio.TimeoutError:
                pass
            else:
                raise AssertionError("Stalled worker did not time out")
            assert time.monotonic() - started < 3
            assert first["pid"] not in {process.pid for process in workers.children}
            replaced = await workers.calculate({}, {}, 0, timeout=60)
            assert replaced["pid"] != first["pid"]
            assert first["op"] == "simulate"
            assert (await workers.decide({}, "hard", timeout=5))["op"] == "bot"
        finally:
            workers.close()
        assert not workers.children
    asyncio.run(scenario())


def test_two_warm_workers_serve_simultaneous_jobs_in_distinct_processes():
    async def scenario():
        workers = PhysicsWorkers(size=2, handler=echo_handler, initializer=no_init)
        try:
            workers.start()
            deadline = time.monotonic() + 60
            while workers.warm_count < 2:
                assert time.monotonic() < deadline, "Both physics workers must become ready"
                await asyncio.sleep(.02)
            first, second = await asyncio.gather(
                workers.calculate({"match": 1}, {"delay": .2}, 0, timeout=5),
                workers.calculate({"match": 2}, {"delay": .2}, 1, timeout=5),
            )
            assert first["pid"] != second["pid"]
            assert first["state"] == {"match": 1} and second["state"] == {"match": 2}
            assert workers.warm_count == 2
        finally:
            workers.close()
        assert not workers.children

    asyncio.run(scenario())
