from __future__ import annotations

import threading

from agent.memory_manager import MemoryManager


def test_shutdown_drain_reports_clean_empty_manager():
    manager = MemoryManager()
    manager.shutdown_all()
    assert manager.shutdown_drain_state == {
        "status": "drained",
        "abandoned_writes": 0,
        "abandoned_prefetches": 0,
        "active_tasks": 0,
    }


def test_shutdown_drains_queued_fifo_tasks(monkeypatch):
    manager = MemoryManager()
    started = threading.Event()
    release = threading.Event()
    order: list[str] = []

    def first():
        started.set()
        assert release.wait(timeout=2)
        order.append("first")

    manager._submit_background(first)
    assert started.wait(timeout=1)
    manager._submit_background(lambda: order.append("second"))
    threading.Timer(0.05, release.set).start()

    manager.shutdown_all()

    assert order == ["first", "second"]
    assert manager.shutdown_drain_state["status"] == "drained"
