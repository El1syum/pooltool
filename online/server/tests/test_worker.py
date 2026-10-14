import asyncio
import time

from online.server.tests.worker_fixtures import echo_worker, hanging_worker
from online.server.worker import PhysicsWorkers


def test_hanging_physics_is_killed_and_worker_slot_is_reusable():
    async def scenario():
        workers = PhysicsWorkers(size=1, child_target=hanging_worker)
        started = time.monotonic()
        try:
            await workers.calculate({}, {}, 0, timeout=0.2)
        except asyncio.TimeoutError:
            pass
        else:
            raise AssertionError("Stalled worker did not time out")
        assert time.monotonic() - started < 3
        assert not workers.children
        workers.child_target = echo_worker
        assert await workers.calculate({"valid": True}, {}, 1, timeout=5) == {"state": {"valid": True}, "shooter": 1}
        assert not workers.children
        workers.close()
    asyncio.run(scenario())
