"""Fan-native embedded Kanban dispatcher for the desktop backend.

The Electron backend is Fan's long-lived local supervisor.  This module binds
the retained Kanban worker loop to that process and protects every embedded or
standalone daemon with one cross-process advisory lock.
"""

from __future__ import annotations

import atexit
import errno
import logging
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_state_lock = threading.Lock()
_stop_event = threading.Event()
_dispatcher_thread: Optional[threading.Thread] = None
_dispatcher_lock_handle = None


def dispatcher_lock_path() -> Path:
    from fan_cli import kanban_db

    return kanban_db.kanban_home() / "kanban" / ".dispatcher.lock"


def acquire_dispatcher_lock(path: Optional[Path] = None):
    """Return ``(handle, state)`` where state is held/contended/unavailable."""
    target = path or dispatcher_lock_path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        handle = target.open("a+", encoding="utf-8")
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass
    except OSError:
        return None, "unavailable"

    try:
        if os.name == "nt":
            import msvcrt

            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write("\n")
                handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except ImportError:
        handle.close()
        return None, "unavailable"
    except BlockingIOError:
        handle.close()
        return None, "contended"
    except OSError as exc:
        handle.close()
        contention_errnos = {errno.EACCES, errno.EAGAIN}
        if errno.EWOULDBLOCK is not None:
            contention_errnos.add(errno.EWOULDBLOCK)
        windows_contention = getattr(exc, "winerror", None) in {33, 36}
        if exc.errno in contention_errnos or windows_contention:
            return None, "contended"
        logger.warning("kanban dispatcher lock failed at %s: %s", target, exc)
        return None, "unavailable"
    return handle, "held"


def release_dispatcher_lock(handle) -> None:
    if handle is None:
        return
    try:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except (OSError, ImportError):
        pass
    try:
        handle.close()
    except OSError:
        pass


def dispatcher_lock_is_held() -> Optional[bool]:
    """Probe whether another process owns the dispatcher lock."""
    handle, state = acquire_dispatcher_lock()
    if state == "held":
        release_dispatcher_lock(handle)
        return False
    if state == "contended":
        return True
    return None


def _positive_int(value: Any) -> Optional[int]:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _settings() -> dict[str, Any]:
    """Resolve the current server > user > default Kanban configuration."""
    try:
        from fan_cli.config import load_config_readonly

        cfg = load_config_readonly()
    except Exception:
        logger.exception("kanban dispatcher: merged config unavailable; pausing")
        return {"enabled": False, "interval": 60.0}
    raw = cfg.get("kanban") if isinstance(cfg, dict) else {}
    kcfg = raw if isinstance(raw, dict) else {}
    try:
        interval = max(1.0, float(kcfg.get("dispatch_interval_seconds", 60) or 60))
    except (TypeError, ValueError):
        interval = 60.0
    failure_limit = _positive_int(kcfg.get("failure_limit")) or 2
    stale_timeout = _positive_int(kcfg.get("dispatch_stale_timeout_seconds")) or 0
    return {
        "enabled": bool(kcfg.get("dispatch_in_gateway", True)),
        "interval": interval,
        "max_spawn": _positive_int(kcfg.get("max_spawn")),
        "max_in_progress": _positive_int(kcfg.get("max_in_progress")),
        "max_in_progress_per_assignee": _positive_int(
            kcfg.get("max_in_progress_per_assignee")
        ),
        "failure_limit": failure_limit,
        "stale_timeout_seconds": stale_timeout,
        "default_assignee": str(kcfg.get("default_assignee") or "").strip() or None,
        "auto_decompose": bool(kcfg.get("auto_decompose", True)),
        "auto_decompose_per_tick": _positive_int(kcfg.get("auto_decompose_per_tick")) or 3,
    }


def _boards():
    from fan_cli import kanban_db as kb

    try:
        return kb.list_boards(include_archived=False)
    except Exception:
        return [kb.read_board_metadata(kb.DEFAULT_BOARD)]


def _auto_decompose(settings: dict[str, Any]) -> None:
    if not settings.get("auto_decompose"):
        return
    try:
        from fan_cli import kanban_db as kb
        from fan_cli import kanban_decompose as decompose
    except Exception:
        logger.debug("kanban auto-decompose unavailable", exc_info=True)
        return

    remaining = int(settings.get("auto_decompose_per_tick") or 3)
    for board in _boards():
        if remaining <= 0:
            break
        slug = board.get("slug") or kb.DEFAULT_BOARD
        try:
            with kb.scoped_current_board(slug):
                task_ids = decompose.list_triage_ids()
                for task_id in task_ids[:remaining]:
                    remaining -= 1
                    try:
                        outcome = decompose.decompose_task(
                            task_id,
                            author="auto-decomposer",
                        )
                        if getattr(outcome, "ok", False):
                            logger.info("kanban auto-decompose [%s]: %s", slug, task_id)
                    except Exception:
                        logger.exception(
                            "kanban auto-decompose failed [%s]: %s",
                            slug,
                            task_id,
                        )
        except Exception:
            logger.exception("kanban auto-decompose board failed: %s", slug)


def _dispatch_tick(settings: dict[str, Any]) -> None:
    from fan_cli import kanban_db as kb

    _auto_decompose(settings)
    for board in _boards():
        slug = board.get("slug") or kb.DEFAULT_BOARD
        try:
            with kb.connect_closing(board=slug) as conn:
                result = kb.dispatch_once(
                    conn,
                    board=slug,
                    max_spawn=settings.get("max_spawn"),
                    max_in_progress=settings.get("max_in_progress"),
                    failure_limit=int(settings["failure_limit"]),
                    stale_timeout_seconds=int(settings["stale_timeout_seconds"]),
                    default_assignee=settings.get("default_assignee"),
                    max_in_progress_per_assignee=settings.get(
                        "max_in_progress_per_assignee"
                    ),
                )
            if any(
                (
                    result.reclaimed,
                    result.crashed,
                    result.timed_out,
                    result.promoted,
                    result.spawned,
                    result.auto_blocked,
                )
            ):
                logger.info(
                    "kanban dispatcher [%s]: spawned=%d reclaimed=%d crashed=%d "
                    "timed_out=%d promoted=%d auto_blocked=%d",
                    slug,
                    len(result.spawned),
                    result.reclaimed,
                    len(result.crashed),
                    len(result.timed_out),
                    result.promoted,
                    len(result.auto_blocked),
                )
        except sqlite3.DatabaseError:
            logger.exception("kanban dispatcher database tick failed: %s", slug)
        except Exception:
            logger.exception("kanban dispatcher tick failed: %s", slug)


def _run_embedded_dispatcher() -> None:
    global _dispatcher_lock_handle, _dispatcher_thread
    warned_unavailable = False
    try:
        while not _stop_event.is_set():
            settings = _settings()
            interval = float(settings.get("interval") or 60.0)
            if not settings.get("enabled"):
                if _dispatcher_lock_handle is not None:
                    release_dispatcher_lock(_dispatcher_lock_handle)
                    _dispatcher_lock_handle = None
                _stop_event.wait(min(interval, 5.0))
                continue

            if _dispatcher_lock_handle is None:
                handle, state = acquire_dispatcher_lock()
                if state != "held":
                    if state == "unavailable" and not warned_unavailable:
                        logger.error(
                            "kanban dispatcher lock unavailable; refusing unlocked dispatch"
                        )
                        warned_unavailable = True
                    elif state == "contended":
                        logger.debug("kanban dispatcher lock held by another process")
                    _stop_event.wait(min(interval, 5.0))
                    continue
                warned_unavailable = False
                _dispatcher_lock_handle = handle
                logger.info(
                    "kanban dispatcher embedded in desktop backend (lock=%s)",
                    dispatcher_lock_path(),
                )

            _dispatch_tick(settings)
            _stop_event.wait(interval)
    finally:
        release_dispatcher_lock(_dispatcher_lock_handle)
        _dispatcher_lock_handle = None
        with _state_lock:
            if _dispatcher_thread is threading.current_thread():
                _dispatcher_thread = None


def start_embedded_dispatcher() -> bool:
    """Start the idempotent desktop-owned dispatcher thread."""
    global _dispatcher_thread
    with _state_lock:
        if _dispatcher_thread is not None and _dispatcher_thread.is_alive():
            return False
        _stop_event.clear()
        _dispatcher_thread = threading.Thread(
            target=_run_embedded_dispatcher,
            name="fan-kanban-dispatcher",
            daemon=True,
        )
        _dispatcher_thread.start()
    return True


def stop_embedded_dispatcher(*, join_timeout: float = 5.0) -> None:
    """Stop the embedded loop and release its process-wide lock."""
    _stop_event.set()
    with _state_lock:
        thread = _dispatcher_thread
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=max(0.0, join_timeout))


atexit.register(stop_embedded_dispatcher)
