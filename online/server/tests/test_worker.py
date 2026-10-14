import asyncio
import time

from online.server.tests.worker_fixtures import echo_handler, no_init
from online.server.worker import PhysicsWorkers


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
