"""Small, fail-safe, rotating crash trace writer used before logging is ready."""

from __future__ import annotations

import os
import stat
import threading
from pathlib import Path

from fan_cli.support_bundle import redact_support_text

_WRITE_LOCK = threading.Lock()


def _set_fd_private_mode(descriptor: int) -> None:
    """Best-effort POSIX mode hardening; Windows has no ``os.fchmod``."""
    fchmod = getattr(os, "fchmod", None)
    if not callable(fchmod):
        return
    try:
        fchmod(descriptor, 0o600)
    except OSError:
        pass


def _regular_or_missing(path: Path) -> int:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return 0
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise OSError("crash log target is not a regular file")
    return info.st_size


def _rotate(path: Path, backups: int) -> None:
    if backups <= 0:
        path.unlink(missing_ok=True)
        return
    for index in range(backups, 0, -1):
        source = path if index == 1 else Path(f"{path}.{index - 1}")
        target = Path(f"{path}.{index}")
        target.unlink(missing_ok=True)
        try:
            source.replace(target)
        except FileNotFoundError:
            continue


def append_redacted_crash(
    path: Path,
    title: str,
    trace: str,
    *,
    max_bytes: int = 2 * 1024 * 1024,
    backups: int = 2,
) -> None:
    """Append one redacted trace with rotation and owner-only permissions.

    Callers intentionally wrap this function in ``try/except`` because crash
    reporting must never replace the original failure.
    """
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")
    safe = redact_support_text(f"\n=== {title} ===\n{trace}")
    payload = safe.encode("utf-8", errors="replace")
    if len(payload) > max_bytes:
        head_bytes = min(64 * 1024, max_bytes // 4)
        marker = b"\n[trace truncated]\n"
        tail_bytes = max(0, max_bytes - head_bytes - len(marker))
        payload = payload[:head_bytes] + marker + payload[-tail_bytes:]

    path = Path(path)
    with _WRITE_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        size = _regular_or_missing(path)
        if size and size + len(payload) > max_bytes:
            _rotate(path, backups)
        flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags, 0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise OSError("crash log target is not a regular file")
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                view = view[written:]
            _set_fd_private_mode(descriptor)
        finally:
            os.close(descriptor)


__all__ = ["append_redacted_crash"]
