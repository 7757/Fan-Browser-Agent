"""Centralized logging setup for Fan Agent.

Provides a single ``setup_logging()`` entry point that both the CLI and
gateway call early in their startup path.  All log files live under
``~/.fan/logs/`` (profile-aware via ``get_fan_home()``).

Log files produced:
    agent.log   — INFO+, all agent/tool/session activity (the main log)
    errors.log  — WARNING+, errors and warnings only (quick triage)
    gateway.log — INFO+, gateway-only events (created when mode="gateway")
    gui.log     — INFO+, dashboard/websocket/TUI-gateway events
                  (created when mode="gui")

All files use ``RotatingFileHandler`` with ``RedactingFormatter`` so
secrets are never written to disk.

Component separation:
    gateway.log only receives records from legacy ``gateway.*`` loggers.
    gui.log receives dashboard-side records from ``fan_cli.web_server``,
    ``tui_gateway.*``, and ``uvicorn.*``.
    agent.log remains the catch-all (everything goes there).

Session context:
    Call ``set_session_context(session_id)`` at the start of a conversation
    and ``clear_session_context()`` when done.  All log lines emitted on
    that thread will include ``[session_id]`` for filtering/correlation.
"""

import atexit
import copy
import logging
import os
import queue
import stat
import sys
import threading
from logging.handlers import QueueHandler, QueueListener
from pathlib import Path
from typing import Optional, Sequence

if sys.platform == "win32":
    # Windows cannot rename an open log file while another Fan process still
    # holds it. The concurrent handler serializes rollover across processes;
    # POSIX keeps stdlib behavior because managed-mode permissions depend on it.
    from concurrent_log_handler import (
        ConcurrentRotatingFileHandler as RotatingFileHandler,
    )
else:
    from logging.handlers import RotatingFileHandler

from fan_constants import get_config_path, get_fan_home

# Sentinel to track whether setup_logging() has already run.  The function
# is idempotent — calling it twice is safe but the second call is a no-op
# unless ``force=True``.
_logging_initialized = False

# Thread-local storage for per-conversation session context.
_session_context = threading.local()

# Default log format — includes timestamp, level, optional session tag,
# logger name, and message.  The ``%(session_tag)s`` field is guaranteed to
# exist on every LogRecord via _install_session_record_factory() below.
_LOG_FORMAT = "%(asctime)s %(levelname)s%(session_tag)s %(name)s: %(message)s"
_LOG_FORMAT_VERBOSE = "%(asctime)s - %(name)s - %(levelname)s%(session_tag)s - %(message)s"

# Third-party loggers that are noisy at DEBUG/INFO level.
_NOISY_LOGGERS = (
    "openai",
    "openai._base_client",
    "httpx",
    "httpcore",
    "asyncio",
    "hpack",
    "hpack.hpack",
    "grpc",
    "modal",
    "urllib3",
    "urllib3.connectionpool",
    "websockets",
    "charset_normalizer",
    "markdown_it",
)


# ---------------------------------------------------------------------------
# Public session context API
# ---------------------------------------------------------------------------

def set_session_context(session_id: str) -> None:
    """Set the session ID for the current thread.

    All subsequent log records on this thread will include ``[session_id]``
    in the formatted output.  Call at the start of ``run_conversation()``.
    """
    _session_context.session_id = session_id


def clear_session_context() -> None:
    """Clear the session ID for the current thread."""
    _session_context.session_id = None


# ---------------------------------------------------------------------------
# Record factory — injects session_tag into every LogRecord at creation
# ---------------------------------------------------------------------------

def _install_session_record_factory() -> None:
    """Replace the global LogRecord factory with one that adds ``session_tag``.

    Unlike a ``logging.Filter`` on a handler or logger, the record factory
    runs for EVERY record in the process — including records that propagate
    from child loggers and records handled by third-party handlers.  This
    guarantees ``%(session_tag)s`` is always available in format strings,
    eliminating the KeyError that would occur if a handler used our format
    without having a ``_SessionFilter`` attached.

    Idempotent — checks for a marker attribute to avoid double-wrapping if
    the module is reloaded.
    """
    current_factory = logging.getLogRecordFactory()
    if getattr(current_factory, "_fan_session_injector", False):
        return  # already installed

    def _session_record_factory(*args, **kwargs):
        record = current_factory(*args, **kwargs)
        sid = getattr(_session_context, "session_id", None)
        record.session_tag = f" [{sid}]" if sid else ""  # type: ignore[attr-defined]
        return record

    _session_record_factory._fan_session_injector = True  # type: ignore[attr-defined]
    logging.setLogRecordFactory(_session_record_factory)


# Install immediately on import — session_tag is available on all records
# from this point forward, even before setup_logging() is called.
_install_session_record_factory()


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------

class _ComponentFilter(logging.Filter):
    """Only pass records whose logger name starts with one of *prefixes*.

    Used to route gateway-specific records to ``gateway.log`` while
    keeping ``agent.log`` as the catch-all.
    """

    def __init__(self, prefixes: Sequence[str]) -> None:
        super().__init__()
        self._prefixes = tuple(prefixes)

    def filter(self, record: logging.LogRecord) -> bool:
        return record.name.startswith(self._prefixes)


# Logger name prefixes that belong to each component.
# Used by _ComponentFilter and exposed for ``fan logs --component``.
COMPONENT_PREFIXES = {
    "gateway": ("gateway", "fan_plugins"),
    "agent": ("agent", "run_agent", "model_tools", "batch_runner"),
    "tools": ("tools",),
    "cli": ("fan_cli", "cli"),
    "cron": ("cron",),
    "gui": (
        "fan_cli.web_server",
        "tui_gateway",
        "uvicorn",
    ),
}


# ---------------------------------------------------------------------------
# Main setup
# ---------------------------------------------------------------------------

def setup_logging(
    *,
    fan_home: Optional[Path] = None,
    log_level: Optional[str] = None,
    max_size_mb: Optional[int] = None,
    backup_count: Optional[int] = None,
    mode: Optional[str] = None,
    force: bool = False,
) -> Path:
    """Configure the Fan logging subsystem.

    Safe to call multiple times — the second call is a no-op unless
    *force* is ``True``.

    Parameters
    ----------
    fan_home
        Override for the Fan home directory.  Falls back to
        ``get_fan_home()`` (profile-aware).
    log_level
        Minimum level for the ``agent.log`` file handler.  Accepts any
        standard Python level name (``"DEBUG"``, ``"INFO"``, ``"WARNING"``).
        Defaults to ``"INFO"`` or the value from config.yaml ``logging.level``.
    max_size_mb
        Maximum size of each log file in megabytes before rotation.
        Defaults to 5 or the value from config.yaml ``logging.max_size_mb``.
    backup_count
        Number of rotated backup files to keep.
        Defaults to 3 or the value from config.yaml ``logging.backup_count``.
    mode
        Caller context: ``"cli"``, ``"gateway"``, ``"gui"``, ``"cron"``.
        When ``"gateway"``, an additional ``gateway.log`` file is created
        that receives only gateway-component records.
        When ``"gui"``, an additional ``gui.log`` file is created that
        receives dashboard and TUI-gateway component records.
    force
        Re-run setup even if it has already been called.

    Returns
    -------
    Path
        The ``logs/`` directory where files are written.
    """
    global _logging_initialized
    home = fan_home or get_fan_home()
    log_dir = home / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    # Read config defaults (best-effort — config may not be loaded yet).
    cfg_level, cfg_max_size, cfg_backup = _read_logging_config()

    level_name = (log_level or cfg_level or "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    max_bytes = (max_size_mb or cfg_max_size or 5) * 1024 * 1024
    backups = backup_count or cfg_backup or 3

    # Lazy import to avoid circular dependency at module load time.
    from agent.redact import RedactingFormatter

    root = logging.getLogger()

    # --- agent.log (INFO+) — the main activity log -------------------------
    _add_rotating_handler(
        root,
        log_dir / "agent.log",
        level=level,
        max_bytes=max_bytes,
        backup_count=backups,
        formatter=RedactingFormatter(_LOG_FORMAT),
    )

    # --- errors.log (WARNING+) — quick triage log --------------------------
    _add_rotating_handler(
        root,
        log_dir / "errors.log",
        level=logging.WARNING,
        max_bytes=2 * 1024 * 1024,
        backup_count=2,
        formatter=RedactingFormatter(_LOG_FORMAT),
    )

    # --- gateway.log (INFO+, gateway component only) ------------------------
    if mode == "gateway":
        _add_rotating_handler(
            root,
            log_dir / "gateway.log",
            level=logging.INFO,
            max_bytes=5 * 1024 * 1024,
            backup_count=3,
            formatter=RedactingFormatter(_LOG_FORMAT),
            log_filter=_ComponentFilter(COMPONENT_PREFIXES["gateway"]),
        )

    # --- gui.log (INFO+, dashboard/tui-gateway components) -----------------
    if mode == "gui":
        _add_rotating_handler(
            root,
            log_dir / "gui.log",
            level=logging.INFO,
            max_bytes=10 * 1024 * 1024,
            backup_count=5,
            formatter=RedactingFormatter(_LOG_FORMAT),
            log_filter=_ComponentFilter(COMPONENT_PREFIXES["gui"]),
        )

    if _logging_initialized and not force:
        return log_dir

    # Ensure root logger level is low enough for the handlers to fire.
    if root.level == logging.NOTSET or root.level > level:
        root.setLevel(level)

    # Suppress noisy third-party loggers.
    for name in _NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)

    _logging_initialized = True
    return log_dir


def setup_verbose_logging() -> None:
    """Enable DEBUG-level console logging for ``--verbose`` / ``-v`` mode.

    Called by ``AIAgent.__init__()`` when ``verbose_logging=True``.
    """
    from agent.redact import RedactingFormatter

    root = logging.getLogger()

    # Avoid adding duplicate stream handlers.
    for h in root.handlers:
        if isinstance(h, logging.StreamHandler) and not isinstance(h, RotatingFileHandler):
            if getattr(h, "_fan_verbose", False):
                return

    handler = logging.StreamHandler()
    handler.setLevel(logging.DEBUG)
    handler.setFormatter(RedactingFormatter(_LOG_FORMAT_VERBOSE, datefmt="%H:%M:%S"))
    handler._fan_verbose = True  # type: ignore[attr-defined]
    root.addHandler(handler)

    # Lower root logger level so DEBUG records reach all handlers.
    if root.level > logging.DEBUG:
        root.setLevel(logging.DEBUG)

    # Keep third-party libraries at WARNING to reduce noise.
    for name in _NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    # rex-deploy at INFO for sandbox status.
    logging.getLogger("rex-deploy").setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

class _ManagedRotatingFileHandler(RotatingFileHandler):
    """RotatingFileHandler with private local permissions and safe reopening.

    Two responsibilities:

    1.  Local profiles use owner-only ``0600`` because support logs may still
        contain private paths or conversation-adjacent diagnostics after
        redaction. Managed NixOS installs keep ``0660`` so the gateway and
        interactive users can share the setgid state directory.

    2.  ``RotatingFileHandler`` keeps an open file descriptor.  If anything
        rotates the file *externally* (``logrotate``, manual ``mv``,
        another process rotating under us, a transient unlink), our fd
        keeps pointing at the renamed/unlinked inode and every subsequent
        write goes to ``gateway.log.1`` instead of ``gateway.log`` — silent
        log loss for the file every operator expects to read.  Before each
        emit we ``stat`` ``baseFilename`` and compare it against the open
        stream's inode; on mismatch we reopen.  This is the same pattern
        as stdlib ``WatchedFileHandler.reopenIfNeeded()``, adapted for
        rotating handlers.
    """

    def __init__(self, *args, **kwargs):
        from fan_cli.config import is_managed
        self._managed = is_managed()
        super().__init__(*args, **kwargs)
        self._tighten_existing_log_permissions()
        # Snapshot the inode of the currently open stream so emit() can
        # detect external rotation without an extra fstat per write.
        self._stat_dev: Optional[int] = None
        self._stat_ino: Optional[int] = None
        self._record_stream_stat()

    @property
    def _profile_mode(self) -> int:
        return 0o660 if self._managed else 0o600

    def _secure_existing_file(self, filename: str) -> None:
        """Tighten one regular log file without following a symlink."""
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(filename, flags)
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode):
                raise OSError(f"refusing non-regular log file: {filename}")
            try:
                os.fchmod(descriptor, self._profile_mode)
            except (AttributeError, OSError):
                pass
        finally:
            os.close(descriptor)

    def _tighten_existing_log_permissions(self) -> None:
        """Apply the profile mode to the current file and retained backups."""
        for index in range(0, max(0, int(self.backupCount)) + 1):
            filename = self.baseFilename if index == 0 else f"{self.baseFilename}.{index}"
            try:
                existing = os.lstat(filename)
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(existing.st_mode) or not stat.S_ISREG(existing.st_mode):
                continue
            try:
                self._secure_existing_file(filename)
            except OSError:
                continue

    def _record_stream_stat(self) -> None:
        """Snapshot dev/ino of ``baseFilename`` so we can detect external rotation."""
        try:
            st = os.lstat(self.baseFilename)
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
                raise OSError("refusing non-regular log path")
            self._stat_dev, self._stat_ino = st.st_dev, st.st_ino
        except OSError:
            self._stat_dev, self._stat_ino = None, None

    def _reopen_if_externally_rotated(self) -> None:
        """Reopen the stream when ``baseFilename`` no longer matches our fd.

        Triggered when ``baseFilename`` was renamed (logrotate), unlinked,
        or replaced by a different inode.  Silent + best-effort: any error
        falls back to the existing (possibly stale) stream so logging keeps
        working instead of dying on a stat failure.
        """
        try:
            st = os.lstat(self.baseFilename)
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
                raise OSError("refusing non-regular log path")
        except FileNotFoundError:
            # File was rotated/unlinked underneath us.  Close + reopen so a
            # fresh inode is created at the expected path.
            try:
                if self.stream is not None:
                    self.stream.close()
            except Exception:
                pass
            self.stream = None  # type: ignore[assignment]
            try:
                self.stream = self._open()
                self._record_stream_stat()
            except Exception:
                # Couldn't reopen — leave stream=None; next emit will
                # bail rather than write to a stale inode.
                pass
            return
        except OSError:
            return  # transient — try again on the next emit

        if self._stat_dev is None or self._stat_ino is None:
            self._stat_dev, self._stat_ino = st.st_dev, st.st_ino
            return

        if (st.st_dev, st.st_ino) != (self._stat_dev, self._stat_ino):
            # baseFilename now points at a DIFFERENT inode than the one we
            # hold open.  Close the old stream and open the new file.
            try:
                if self.stream is not None:
                    self.stream.close()
            except Exception:
                pass
            self.stream = None  # type: ignore[assignment]
            try:
                self.stream = self._open()
                self._stat_dev, self._stat_ino = st.st_dev, st.st_ino
            except Exception:
                pass

    def emit(self, record: logging.LogRecord) -> None:
        # Cheap-ish stat-per-record check; the kernel caches inode metadata
        # so the syscall is sub-microsecond on a hot file.
        if self.stream is not None or os.path.exists(self.baseFilename):
            self._reopen_if_externally_rotated()
        super().emit(record)

    def _open(self):
        # POSIX can make the no-follow guarantee atomically. Windows retains
        # the concurrent handler's shared-open implementation, then validates
        # that the opened descriptor still matches the path before returning.
        if os.name != "nt" and getattr(os, "O_NOFOLLOW", 0):
            flags = os.O_WRONLY | os.O_CREAT | getattr(os, "O_BINARY", 0)
            if "a" in self.mode:
                flags |= os.O_APPEND
            elif "w" in self.mode:
                flags |= os.O_TRUNC
            elif "x" in self.mode:
                flags |= os.O_EXCL
            else:
                raise ValueError(f"unsupported secure log mode: {self.mode}")
            flags |= os.O_NOFOLLOW
            descriptor = os.open(self.baseFilename, flags, self._profile_mode)
            try:
                opened = os.fstat(descriptor)
                if not stat.S_ISREG(opened.st_mode):
                    raise OSError("refusing non-regular log file")
                try:
                    os.fchmod(descriptor, self._profile_mode)
                except (AttributeError, OSError):
                    pass
                stream = os.fdopen(
                    descriptor,
                    self.mode,
                    encoding=self.encoding,
                    errors=self.errors,
                )
                descriptor = -1
                return stream
            finally:
                if descriptor >= 0:
                    os.close(descriptor)

        try:
            existing = os.lstat(self.baseFilename)
        except FileNotFoundError:
            existing = None
        if existing is not None and (
            stat.S_ISLNK(existing.st_mode) or not stat.S_ISREG(existing.st_mode)
        ):
            raise OSError("refusing non-regular log path")

        stream = super()._open()
        try:
            opened = os.fstat(stream.fileno())
            current = os.lstat(self.baseFilename)
            if (
                stat.S_ISLNK(current.st_mode)
                or not stat.S_ISREG(current.st_mode)
                or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)
            ):
                raise OSError("log path changed while it was being opened")
            try:
                os.fchmod(stream.fileno(), self._profile_mode)
            except (AttributeError, OSError):
                pass
            return stream
        except Exception:
            stream.close()
            raise

    def doRollover(self):
        super().doRollover()
        self._tighten_existing_log_permissions()
        # Our own rollover writes a new baseFilename; refresh the snapshot
        # so the next emit doesn't mistake it for external rotation.
        self._record_stream_stat()


# ---------------------------------------------------------------------------
# Asynchronous file logging — keep rotation and disk I/O off request threads
#
# Several Fan processes can share a rotating log on Windows.  The concurrent
# handler serializes rollover with a cross-process lock, and waiting for that
# lock from an asyncio request/WebSocket thread can stall the desktop UI.  File
# handlers therefore run behind one in-process QueueListener; emitters only
# enqueue an in-memory record.
# ---------------------------------------------------------------------------

_log_queue: "Optional[queue.SimpleQueue]" = None
_queue_listener: Optional[QueueListener] = None
_queued_file_handlers: list[logging.Handler] = []
_queue_atexit_registered = False
# setup_logging can run concurrently with a plugin/CLI path that flushes or
# resets the queue.  Guard every read-modify-write of the shared listener
# state so registration never leaves two listeners or an orphaned worker.
_queue_state_lock = threading.Lock()


class _NonFormattingQueueHandler(QueueHandler):
    """QueueHandler for records that stay within this process.

    The stdlib implementation formats records for cross-process pickling,
    which removes ``args`` and ``exc_info`` before RedactingFormatter sees
    them.  Keep the original fields for deferred formatting, but give the
    listener a shallow copy so synchronous handlers cannot mutate the same
    record while the worker thread formats it.
    """

    def prepare(self, record: logging.LogRecord) -> logging.LogRecord:
        return copy.copy(record)


def _stop_queue_listener_locked() -> None:
    """Flush and stop the listener while ``_queue_state_lock`` is held."""
    global _queue_listener
    listener, _queue_listener = _queue_listener, None
    if listener is not None:
        try:
            listener.stop()
        except Exception:
            pass


def _stop_queue_listener() -> None:
    """Flush and stop the background log listener (idempotent)."""
    with _queue_state_lock:
        _stop_queue_listener_locked()


def _register_queued_handler(handler: logging.Handler) -> None:
    """Attach a file handler to the shared listener rather than a logger."""
    global _log_queue, _queue_listener, _queue_atexit_registered
    with _queue_state_lock:
        if _log_queue is None:
            _log_queue = queue.SimpleQueue()
            queue_handler = _NonFormattingQueueHandler(_log_queue)
            queue_handler._fan_queue = True  # type: ignore[attr-defined]
            # Funnel through root so propagated records from every component
            # take the non-blocking path.
            logging.getLogger().addHandler(queue_handler)

        _queued_file_handlers.append(handler)
        # setup_logging only adds a few handlers during initialization.  Stop
        # then rebuild the listener so its target set stays complete.
        if _queue_listener is not None:
            _queue_listener.stop()
        _queue_listener = QueueListener(
            _log_queue, *_queued_file_handlers, respect_handler_level=True
        )
        _queue_listener.start()

        if not _queue_atexit_registered:
            # Registered after logging.shutdown, so LIFO atexit order stops
            # the listener before its target file handlers are closed.
            atexit.register(_stop_queue_listener)
            _queue_atexit_registered = True


def flush_log_queue() -> None:
    """Synchronously flush queued records without tearing logging down."""
    with _queue_state_lock:
        listener = _queue_listener
        if listener is not None:
            listener.stop()
            listener.start()


def drain_log_queue(timeout: float = 1.0) -> None:
    """Best-effort bounded drain for a path that will call ``os._exit``.

    A listener can itself be waiting on the cross-process rotation lock.  Do
    not let that condition re-freeze a hard-exit path merely to save a final
    log record.
    """
    listener = _queue_listener
    if listener is None:
        return

    def _drain() -> None:
        try:
            listener.stop()
        except Exception:
            pass

    thread = threading.Thread(target=_drain, name="fan-log-drain", daemon=True)
    thread.start()
    thread.join(timeout)


def rotating_file_handlers() -> list[logging.Handler]:
    """Return active rotating handlers, which live on the QueueListener."""
    return list(_queued_file_handlers)


def _reset_queued_handlers() -> None:
    """Tear down queued handlers for isolated in-process setup cycles."""
    global _log_queue
    with _queue_state_lock:
        _stop_queue_listener_locked()
        root = logging.getLogger()
        for handler in list(root.handlers):
            if getattr(handler, "_fan_queue", False):
                root.removeHandler(handler)
        for handler in list(_queued_file_handlers):
            try:
                handler.close()
            except Exception:
                pass
        _queued_file_handlers.clear()
        _log_queue = None


def _add_rotating_handler(
    logger: logging.Logger,
    path: Path,
    *,
    level: int,
    max_bytes: int,
    backup_count: int,
    formatter: logging.Formatter,
    log_filter: Optional[logging.Filter] = None,
) -> None:
    """Add a ``RotatingFileHandler`` to *logger*, skipping if one already
    exists for the same resolved file path (idempotent).

    Parameters
    ----------
    log_filter
        Optional filter to attach to the handler (e.g. ``_ComponentFilter``
        for gateway.log).
    """
    resolved = path.absolute()
    for existing in _queued_file_handlers:
        if (
            isinstance(existing, RotatingFileHandler)
            and Path(getattr(existing, "baseFilename", "")).absolute() == resolved
        ):
            return  # already attached

    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        handler = _ManagedRotatingFileHandler(
            str(path), maxBytes=max_bytes, backupCount=backup_count,
            encoding="utf-8",
        )
    except OSError:
        # An unsafe or unavailable diagnostic path must not prevent Fan from
        # starting. Skip only this file handler; other logging stays active.
        return
    handler.setLevel(level)
    handler.setFormatter(formatter)
    if log_filter is not None:
        handler.addFilter(log_filter)
    _register_queued_handler(handler)


def _read_logging_config():
    """Best-effort read of ``logging.*`` from config.yaml.

    Returns ``(level, max_size_mb, backup_count)`` — any may be ``None``.
    """
    try:
        import yaml
        config_path = get_config_path()
        if config_path.exists():
            with open(config_path, "r", encoding="utf-8") as f:
                cfg = yaml.safe_load(f) or {}
            log_cfg = cfg.get("logging", {})
            if isinstance(log_cfg, dict):
                return (
                    log_cfg.get("level"),
                    log_cfg.get("max_size_mb"),
                    log_cfg.get("backup_count"),
                )
    except Exception:
        pass
    return (None, None, None)
