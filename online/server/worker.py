"""Killable physics processes: a stalled simulation cannot occupy a CPU forever."""

from __future__ import annotations

import asyncio
import multiprocessing
import os
import time


def _calculate_child(pipe, state, shot, shooter):
    try:
        from .physics import PhysicsEngine

        engine = PhysicsEngine()
        engine.warmup()
        result = engine.simulate(state, shot, shooter=shooter)
        pipe.send(("ok", result))
    except ValueError as error:
        pipe.send(("rejected", str(error)))
    except BaseException:
        pipe.send(("failed", "Physics calculation failed; the turn was restored"))
    finally:
        pipe.close()


class PhysicsWorkers:
    def __init__(self, size=None, *, child_target=_calculate_child):
        self.capacity = asyncio.Semaphore(size or int(os.getenv("PHYSICS_WORKERS", "2")))
        self.context = multiprocessing.get_context("spawn")
        self.children = set()
        self.child_target = child_target

    async def calculate(self, state, shot, shooter, timeout):
        # Waiting for capacity is bounded as well as the actual simulation.
        await asyncio.wait_for(self.capacity.acquire(), timeout=timeout)
        reader, writer = self.context.Pipe(duplex=False)
        process = self.context.Process(target=self.child_target, args=(writer, state, shot, shooter), daemon=True)
        try:
            process.start()
            writer.close()
            self.children.add(process)
            deadline = time.monotonic() + timeout
            while not reader.poll():
                if not process.is_alive():
                    raise RuntimeError("Physics worker stopped without a result")
                if time.monotonic() >= deadline:
                    raise asyncio.TimeoutError
                await asyncio.sleep(0.025)
            # A large trajectory is transferred off the event-loop thread.
            status, result = await asyncio.wait_for(asyncio.to_thread(reader.recv), timeout=max(0.05, deadline - time.monotonic()))
            if status == "rejected":
                raise ValueError(result)
            if status != "ok":
                raise RuntimeError(result)
            return result
        finally:
            reader.close()
            writer.close()
            if process.pid is not None:
                process.join(timeout=0.15)
            if process.is_alive():
                process.terminate()
            if process.pid is not None:
                process.join(timeout=1)
                if process.is_alive():
                    process.kill()
                    process.join(timeout=1)
            self.children.discard(process)
            self.capacity.release()

    def close(self):
        for process in tuple(self.children):
            if process.is_alive():
                process.terminate()
