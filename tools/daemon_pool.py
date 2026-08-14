"""ThreadPoolExecutor variant whose abandoned workers cannot block exit.

The stdlib executor registers every worker in a global atexit join table.
Consequently ``shutdown(wait=False)`` still hangs interpreter shutdown when a
tool or provider is permanently blocked in native/network I/O.  These workers
are daemon threads and deliberately skip that registration; callers must use
explicit bounded waits for work whose completion is required for durability.
"""

from __future__ import annotations

import threading
import weakref
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures.thread import _worker

__all__ = ["DaemonThreadPoolExecutor"]


class DaemonThreadPoolExecutor(ThreadPoolExecutor):
    """A normal executor whose workers do not keep the process alive."""

    def _adjust_thread_count(self) -> None:
        if self._idle_semaphore.acquire(timeout=0):
            return

        def weakref_cb(_, queue=self._work_queue):
            queue.put(None)

        num_threads = len(self._threads)
        if num_threads < self._max_workers:
            thread_name = "%s_%d" % (
                self._thread_name_prefix or self,
                num_threads,
            )
            thread = threading.Thread(
                name=thread_name,
                target=_worker,
                args=(
                    weakref.ref(self, weakref_cb),
                    self._work_queue,
                    self._initializer,
                    self._initargs,
                ),
                daemon=True,
            )
            thread.start()
            self._threads.add(thread)
