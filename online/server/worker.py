"""Warm, killable physics processes.

Each worker imports pooltool and compiles the collision path once, then serves
shots over a pipe.  A stalled or crashed simulation is killed and replaced in
the background, so it cannot occupy a CPU forever, and players never wait for
process startup on a normal shot.
"""

from __future__ import annotations

import asyncio
import logging
import multiprocessing
import os
import time

log = logging.getLogger(__name__)
READY_TIMEOUT = 180


def init_physics():
    from .physics import PhysicsEngine

    engine = PhysicsEngine()
    engine.warmup()
    return engine


def handle(engine, op, state, payload, shooter):
    if op == "bot":
        from .bot import decide

        return decide(state, payload.get("difficulty", "medium"), seed=payload.get("seed"))
    return engine.simulate(state, payload, shooter=shooter)


def _serve(pipe, initializer, handler):
    try:
        context = initializer()
    except BaseException as error:
        pipe.send(("startFailed", type(error).__name__))
        return
    pipe.send(("ready", None))
    while True:
        try:
            job = pipe.recv()
        except EOFError:
            return
        if job is None:
            return
        op, state, payload, shooter = job
        try:
            pipe.send(("ok", handler(context, op, state, payload, shooter)))
        except ValueError as error:
            pipe.send(("rejected", str(error)))
        except BaseException:
            pipe.send(("failed", "Ошибка расчёта удара; ход восстановлен"))


class _Worker:
    def __init__(self, process, conn):
        self.process = process
        self.conn = conn
        self.jobs = 0

    def kill(self):
        try:
            self.conn.close()
        except OSError:
            pass
        if self.process.is_alive():
            self.process.terminate()
            self.process.join(timeout=1)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(timeout=1)


class PhysicsWorkers:
    def __init__(self, size=None, *, handler=handle, initializer=init_physics, max_jobs=500):
        self.size = size or int(os.getenv("PHYSICS_WORKERS", "2"))
        self.context = multiprocessing.get_context("spawn")
        self.handler = handler
        self.initializer = initializer
        self.max_jobs = max_jobs
        self.idle: asyncio.Queue[_Worker] | None = None
        self.workers: set[_Worker] = set()
        self.warm: set[_Worker] = set()
        self.tasks: set[asyncio.Task] = set()
        self.closed = False

    @property
    def children(self):
        return {worker.process for worker in self.workers}

    def start(self):
        if self.idle is None:
            self.idle = asyncio.Queue()
            for _ in range(self.size):
                self._replace()

    def _replace(self, delay=0.0):
        if self.closed:
            return
        task = asyncio.create_task(self._launch(delay))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def _launch(self, delay):
        if delay:
            await asyncio.sleep(delay)
        parent, child = self.context.Pipe(duplex=True)
        process = self.context.Process(target=_serve, args=(child, self.initializer, self.handler), daemon=True)
        process.start()
        child.close()
        worker = _Worker(process, parent)
        self.workers.add(worker)
        try:
            deadline = time.monotonic() + READY_TIMEOUT
            while not parent.poll():
                if not process.is_alive() or time.monotonic() >= deadline:
                    raise RuntimeError("Physics worker did not start")
                await asyncio.sleep(0.05)
            status, detail = parent.recv()
            if status != "ready":
                raise RuntimeError(f"Physics worker failed to start: {detail}")
        except asyncio.CancelledError:
            self._discard(worker)
            raise
        except Exception:
            log.exception("Physics worker startup failed; retrying")
            self._discard(worker)
            self._replace(delay=5)
            return
        if self.closed:
            self._discard(worker)
        else:
            self.warm.add(worker)
            self.idle.put_nowait(worker)

    @property
    def warm_count(self):
        return len(self.warm)

    def _discard(self, worker):
        self.workers.discard(worker)
        self.warm.discard(worker)
        worker.kill()

    async def calculate(self, state, shot, shooter, timeout):
        return await self._run("simulate", state, shot, shooter, timeout)

    async def decide(self, state, difficulty, timeout, seed=None):
        """Bot move for the side to play: {"placement": [x, y] | None, "shot": {...}}."""
        return await self._run("bot", state, {"difficulty": difficulty, "seed": seed}, None, timeout)

    async def _run(self, op, state, payload, shooter, timeout):
        self.start()
        deadline = time.monotonic() + timeout
        # Waiting for a free warm worker is bounded as well as the actual simulation.
        worker = await asyncio.wait_for(self.idle.get(), timeout=timeout)
        healthy = False
        try:
            worker.conn.send((op, state, payload, shooter))
            while not worker.conn.poll():
                if not worker.process.is_alive():
                    raise RuntimeError("Physics worker stopped without a result")
                if time.monotonic() >= deadline:
                    raise asyncio.TimeoutError
                await asyncio.sleep(0.005)
            # A large trajectory is transferred off the event-loop thread.
            status, result = await asyncio.wait_for(asyncio.to_thread(worker.conn.recv), timeout=max(0.05, deadline - time.monotonic()))
            healthy = status in ("ok", "rejected")
            worker.jobs += 1
            if status == "rejected":
                raise ValueError(result)
            if status != "ok":
                raise RuntimeError(result)
            return result
        finally:
            if healthy and worker.jobs < self.max_jobs and not self.closed:
                self.idle.put_nowait(worker)
            else:
                self._discard(worker)
                self._replace()

    def close(self):
        self.closed = True
        for task in tuple(self.tasks):
            task.cancel()
        for worker in tuple(self.workers):
            try:
                worker.conn.send(None)
            except (OSError, ValueError):
                pass
            self._discard(worker)
