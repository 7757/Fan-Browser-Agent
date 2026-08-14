"""Local diagnostic report tools for Fan Agent.

Reports are printed locally and are never uploaded by this module. Log content
is always passed through force-mode secret redaction before it is displayed.
"""

import io
import logging
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from fan_constants import get_fan_home

logger = logging.getLogger(__name__)

_REDACTION_BANNER = (
    "[fan debug: sensitive log content was redacted for local display]\n"
)

_EMAIL_ADDRESS_RE = re.compile(
    r"(?<![A-Za-z0-9._%+-])"
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"
    r"(?![A-Za-z0-9._%+-])"
)


# Maximum bytes to read from a single log file for local display.
_MAX_LOG_BYTES = 512_000


# ---------------------------------------------------------------------------
# Log file reading
# ---------------------------------------------------------------------------


@dataclass
class LogSnapshot:
    """Single-read snapshot of a log file used by the local report."""

    path: Optional[Path]
    tail_text: str
    full_text: Optional[str]


def _primary_log_path(log_name: str) -> Optional[Path]:
    """Where *log_name* would live if present. Doesn't check existence."""
    from fan_cli.logs import LOG_FILES

    filename = LOG_FILES.get(log_name)
    return (get_fan_home() / "logs" / filename) if filename else None


def _resolve_log_path(log_name: str) -> Optional[Path]:
    """Find the log file for *log_name*, falling back to the .1 rotation.

    Returns the first non-empty candidate (primary, then .1), or None.
    Callers distinguish 'empty primary' from 'truly missing' via
    :func:`_primary_log_path`.
    """
    primary = _primary_log_path(log_name)
    if primary is None:
        return None

    if primary.exists() and primary.stat().st_size > 0:
        return primary

    rotated = primary.parent / f"{primary.name}.1"
    if rotated.exists() and rotated.stat().st_size > 0:
        return rotated

    return None


def _redact_log_text(text: str) -> str:
    """Run ``redact_sensitive_text`` with ``force=True`` over displayed text.

    Uses ``force=True`` so redaction fires regardless of the operator's
    ``security.redact_secrets`` setting. The local on-disk log file is not
    modified; only the in-memory copy headed to stdout is sanitized. Returns
    the redacted text (or the original when empty / non-string).
    """
    if not text:
        return text
    from agent.redact import redact_sensitive_text

    text = redact_sensitive_text(text, force=True)
    return _EMAIL_ADDRESS_RE.sub("[REDACTED_EMAIL]", text)


def _capture_log_snapshot(
    log_name: str,
    *,
    tail_lines: int,
    max_bytes: int = _MAX_LOG_BYTES,
    redact: bool = True,
) -> LogSnapshot:
    """Capture a log once and derive summary/full-log views from it.

    The report tail and full-log view must come from the same file snapshot.
    Otherwise a rotation/truncate between reads can make them inconsistent.

    When ``redact`` is True (the default), both ``tail_text`` and
    ``full_text`` are run through ``_redact_log_text`` so the snapshot
    returned is safe for local display or an explicit user export. The on-disk
    log file is never modified.
    Pass ``redact=False`` to capture original log content (used by
    ``fan debug share --no-redact``).
    """
    log_path = _resolve_log_path(log_name)
    if log_path is None:
        primary = _primary_log_path(log_name)
        tail = "(file empty)" if primary and primary.exists() else "(file not found)"
        return LogSnapshot(path=None, tail_text=tail, full_text=None)

    try:
        size = log_path.stat().st_size
        if size == 0:
            # race: file was truncated between _resolve_log_path and stat
            return LogSnapshot(path=log_path, tail_text="(file empty)", full_text=None)

        with open(log_path, "rb") as f:
            if size <= max_bytes:
                raw = f.read()
                truncated = False
            else:
                # Read from the end until we have enough bytes for the
                # full-log view and enough newline context to render the
                # summary tail from the same snapshot.
                chunk_size = 8192
                pos = size
                chunks: list[bytes] = []
                total = 0
                newline_count = 0

                while pos > 0 and (total < max_bytes or newline_count <= tail_lines + 1) and total < max_bytes * 2:
                    read_size = min(chunk_size, pos)
                    pos -= read_size
                    f.seek(pos)
                    chunk = f.read(read_size)
                    chunks.insert(0, chunk)
                    total += len(chunk)
                    newline_count += chunk.count(b"\n")
                    chunk_size = min(chunk_size * 2, 65536)

                raw = b"".join(chunks)
                truncated = pos > 0

        full_raw = raw
        if truncated and len(full_raw) > max_bytes:
            cut = len(full_raw) - max_bytes
            # Check whether the cut lands exactly on a line boundary.  If the
            # byte just before the cut position is a newline the first retained
            # byte starts a complete line and we should keep it.  Only drop a
            # partial first line when we're genuinely mid-line.
            on_boundary = cut > 0 and full_raw[cut - 1 : cut] == b"\n"
            full_raw = full_raw[cut:]
            if not on_boundary and b"\n" in full_raw:
                full_raw = full_raw.split(b"\n", 1)[1]

        all_text = raw.decode("utf-8", errors="replace")
        tail_text = "".join(all_text.splitlines(keepends=True)[-tail_lines:]).rstrip("\n")

        full_text = full_raw.decode("utf-8", errors="replace")
        if truncated:
            full_text = f"[... truncated — showing last ~{max_bytes // 1024}KB ...]\n{full_text}"

        if redact:
            tail_text = _redact_log_text(tail_text)
            full_text = _redact_log_text(full_text)

        return LogSnapshot(path=log_path, tail_text=tail_text, full_text=full_text)
    except Exception as exc:
        return LogSnapshot(path=log_path, tail_text=f"(error reading: {exc})", full_text=None)


def _capture_default_log_snapshots(
    log_lines: int, *, redact: bool = True
) -> dict[str, LogSnapshot]:
    """Capture all logs used by the local report exactly once.

    ``redact`` is forwarded to each ``_capture_log_snapshot`` call so all
    captured logs share the same redaction policy for a given run.
    """
    errors_lines = min(log_lines, 100)
    return {
        "agent": _capture_log_snapshot(
            "agent", tail_lines=log_lines, redact=redact
        ),
        "errors": _capture_log_snapshot(
            "errors", tail_lines=errors_lines, redact=redact
        ),
        "gateway": _capture_log_snapshot(
            "gateway", tail_lines=errors_lines, redact=redact
        ),
        "gui": _capture_log_snapshot(
            "gui", tail_lines=errors_lines, redact=redact
        ),
        "desktop": _capture_log_snapshot(
            "desktop", tail_lines=errors_lines, redact=redact
        ),
    }


# ---------------------------------------------------------------------------
# Debug report collection
# ---------------------------------------------------------------------------

def _capture_dump() -> str:
    """Run ``fan dump`` and return its stdout as a string."""
    from fan_cli.dump import run_dump

    class _FakeArgs:
        show_keys = False

    old_stdout = sys.stdout
    sys.stdout = capture = io.StringIO()
    try:
        run_dump(_FakeArgs())
    except SystemExit:
        pass
    finally:
        sys.stdout = old_stdout

    return capture.getvalue()


def collect_debug_report(
    *,
    log_lines: int = 200,
    dump_text: str = "",
    log_snapshots: Optional[dict[str, LogSnapshot]] = None,
) -> str:
    """Build the summary debug report: system dump + log tails.

    Parameters
    ----------
    log_lines
        Number of recent lines to include per log file.
    dump_text
        Pre-captured dump output.  If empty, ``fan dump`` is run
        internally.

    Returns the report as plain text for local display or explicit user export.
    """
    buf = io.StringIO()

    if not dump_text:
        dump_text = _capture_dump()
    buf.write(dump_text)

    if log_snapshots is None:
        log_snapshots = _capture_default_log_snapshots(log_lines)

    # ── Recent log tails (summary only) ──────────────────────────────────
    buf.write("\n\n")
    buf.write(f"--- agent.log (last {log_lines} lines) ---\n")
    buf.write(log_snapshots["agent"].tail_text)
    buf.write("\n\n")

    errors_lines = min(log_lines, 100)
    buf.write(f"--- errors.log (last {errors_lines} lines) ---\n")
    buf.write(log_snapshots["errors"].tail_text)
    buf.write("\n\n")

    buf.write(f"--- gateway.log (last {errors_lines} lines) ---\n")
    buf.write(log_snapshots["gateway"].tail_text)
    buf.write("\n\n")

    buf.write(f"--- gui.log (last {errors_lines} lines) ---\n")
    buf.write(log_snapshots["gui"].tail_text)
    buf.write("\n\n")

    buf.write(f"--- desktop.log (last {errors_lines} lines) ---\n")
    buf.write(log_snapshots["desktop"].tail_text)
    buf.write("\n")

    return buf.getvalue()


# ---------------------------------------------------------------------------
# CLI entry points
# ---------------------------------------------------------------------------

def run_debug_share(args):
    """Collect a redacted diagnostic report and print it locally."""
    log_lines = getattr(args, "lines", 200)
    print("Collecting debug report...")
    dump_text = _capture_dump()
    log_snapshots = _capture_default_log_snapshots(log_lines, redact=True)
    report = collect_debug_report(
        log_lines=log_lines,
        dump_text=dump_text,
        log_snapshots=log_snapshots,
    )
    print(_REDACTION_BANNER + report)

    for log_name in ("agent", "gateway", "gui", "desktop"):
        body = log_snapshots[log_name].full_text
        if not body:
            continue
        print(f"\n\n{'=' * 60}")
        print(f"FULL {log_name}.log")
        print(f"{'=' * 60}\n")
        print(_REDACTION_BANNER + dump_text + f"\n\n--- full {log_name}.log ---\n" + body)


def run_debug(args):
    """Route the local diagnostic command."""
    subcmd = getattr(args, "debug_command", None)
    if subcmd in {None, "share", "local"}:
        run_debug_share(args)
    else:
        print("Usage: fan debug [share|local] [--lines N]")
        print("  Prints a force-redacted diagnostic report locally; no upload occurs.")
