"""
Cron job storage and management.

Jobs are stored in ~/.fan/cron/jobs.json
Output is saved to ~/.fan/cron/output/{job_id}/{timestamp}.md
"""

import contextlib
import copy
import json
import logging
import shutil
import tempfile
import threading
import time
import os
import re
import uuid

# Cross-process advisory file locking for jobs.json critical sections.
# fcntl is Unix-only; on Windows fall back to msvcrt. Either may be absent,
# in which case _jobs_lock() degrades to in-process locking only (the old
# behaviour) rather than failing.
try:
    import fcntl
except ImportError:  # pragma: no cover - non-Unix
    fcntl = None
try:
    import msvcrt
except ImportError:  # pragma: no cover - non-Windows
    msvcrt = None
from datetime import datetime, timedelta
from pathlib import Path
from fan_constants import get_fan_home
from typing import Optional, Dict, List, Any, Union

logger = logging.getLogger(__name__)

from fan_time import now as _fan_now
from utils import atomic_replace

try:
    from croniter import croniter
    HAS_CRONITER = True
except ImportError:
    HAS_CRONITER = False

# =============================================================================
# Configuration
# =============================================================================

FAN_DIR = get_fan_home().resolve()
CRON_DIR = FAN_DIR / "cron"
JOBS_FILE = CRON_DIR / "jobs.json"
TICKER_HEARTBEAT_FILE = CRON_DIR / "ticker_heartbeat"
TICKER_SUCCESS_FILE = CRON_DIR / "ticker_last_success"

# In-process lock protecting load_jobs→modify→save_jobs cycles.
# Required when tick() runs jobs in parallel threads — without this,
# concurrent mark_job_run / advance_next_run calls can clobber each other.
_jobs_file_lock = threading.RLock()
_jobs_lock_state = threading.local()
OUTPUT_DIR = CRON_DIR / "output"
ONESHOT_GRACE_SECONDS = 120
# A claim is renewed while its work is queued or running. The deliberately
# conservative lease only governs crash recovery; it is not a maximum runtime.
RUN_CLAIM_LEASE_SECONDS = 15 * 60
RUN_CLAIM_HEARTBEAT_SECONDS = 30


def _jobs_lock_file() -> Path:
    """Return the advisory lock path for the current cron directory."""
    return CRON_DIR / ".jobs.lock"


@contextlib.contextmanager
def _jobs_lock():
    """Serialize a load_jobs→modify→save_jobs critical section.

    Combines the in-process threading lock (cheap mutual exclusion between
    parallel tick threads) with a cross-process advisory file lock on
    ``<cron dir>/.jobs.lock`` (mutual exclusion between the desktop backend
    and standalone ``fan`` CLI invocations, which previously shared no
    lock at all — a `cron pause` could be silently clobbered by a concurrent
    backend write, leaving a "paused" job still firing).

    The flock is blocking, but every critical section that uses it is short
    (field updates only — no agent execution), so contention resolves in
    milliseconds. If neither fcntl nor msvcrt is available the manager still
    provides in-process locking, matching the historical behaviour.

    Nested calls in the same thread reuse the held lock so legacy callers that
    invoke save_jobs() inside a broader mutation section don't deadlock or try
    to reacquire the advisory file lock.
    """
    depth = getattr(_jobs_lock_state, "depth", 0)
    if depth:
        _jobs_lock_state.depth = depth + 1
        try:
            yield
        finally:
            _jobs_lock_state.depth -= 1
        return

    with _jobs_file_lock:
        _jobs_lock_state.depth = 1
        lock_fd = None
        try:
            try:
                ensure_dirs()
                lock_fd = open(_jobs_lock_file(), "a+", encoding="utf-8")
                lock_fd.seek(0)
                if fcntl is not None:
                    fcntl.flock(lock_fd, fcntl.LOCK_EX)
                elif msvcrt is not None:
                    getattr(msvcrt, "locking")(lock_fd.fileno(), getattr(msvcrt, "LK_LOCK"), 1)
            except (OSError, IOError) as e:
                # Never let a locking failure take down cron writes — fall back to
                # in-process-only protection (still held via _jobs_file_lock).
                logger.warning("jobs.json cross-process lock unavailable (%s); "
                               "proceeding with in-process lock only", e)
            try:
                yield
            finally:
                if lock_fd is not None:
                    try:
                        if fcntl is not None:
                            fcntl.flock(lock_fd, fcntl.LOCK_UN)
                        elif msvcrt is not None:
                            getattr(msvcrt, "locking")(lock_fd.fileno(), getattr(msvcrt, "LK_UNLCK"), 1)
                    except (OSError, IOError):
                        pass
                    finally:
                        lock_fd.close()
        finally:
            _jobs_lock_state.depth = 0

# Fields on a cron job that must never change after creation. ``id`` is used
# as a filesystem path component under ``OUTPUT_DIR``; allowing it to be
# updated lets an unsafe value (``../escape``, absolute path, nested) leak
# into output writes/deletes.
_IMMUTABLE_JOB_FIELDS = frozenset(
    {"id", "run_claim", "deliver", "origin", "last_delivery_error"}
)


def _job_output_dir(job_id: str) -> Path:
    """Resolve a job's output directory, rejecting any path-escape attempt.

    Job IDs are filesystem path components under ``OUTPUT_DIR``. A legacy or
    crafted ID containing ``..``, absolute paths, or nested separators would
    allow output writes/deletes to escape the cron output sandbox. Reject
    anything that isn't a single safe path component.
    """
    text = str(job_id or "").strip()
    if not text or text in {".", ".."} or "/" in text or "\\" in text:
        raise ValueError(f"Invalid cron job id for output path: {job_id!r}")
    if Path(text).is_absolute() or Path(text).drive:
        raise ValueError(f"Invalid cron job id for output path: {job_id!r}")
    return OUTPUT_DIR / text


def _normalize_skill_list(skill: Optional[str] = None, skills: Optional[Any] = None) -> List[str]:
    """Normalize legacy/single-skill and multi-skill inputs into a unique ordered list."""
    if skills is None:
        raw_items = [skill] if skill else []
    elif isinstance(skills, str):
        raw_items = [skills]
    else:
        raw_items = list(skills)

    normalized: List[str] = []
    for item in raw_items:
        text = str(item or "").strip()
        if text and text not in normalized:
            normalized.append(text)
    return normalized


def _apply_skill_fields(job: Dict[str, Any]) -> Dict[str, Any]:
    """Return a job dict with canonical `skills` and legacy `skill` fields aligned."""
    normalized = dict(job)
    skills = _normalize_skill_list(normalized.get("skill"), normalized.get("skills"))
    normalized["skills"] = skills
    normalized["skill"] = skills[0] if skills else None
    return normalized


def _coerce_job_text(value: Any, fallback: str = "") -> str:
    """Coerce legacy/hand-edited nullable cron fields to strings for readers."""
    if value is None:
        return fallback
    return str(value)


def _schedule_display_for_job(job: Dict[str, Any]) -> str:
    display = _coerce_job_text(job.get("schedule_display")).strip()
    if display:
        return display

    schedule = job.get("schedule")
    if isinstance(schedule, dict):
        for key in ("display", "value", "expr", "run_at"):
            text = _coerce_job_text(schedule.get(key)).strip()
            if text:
                return text
    elif schedule is not None:
        return str(schedule)

    return "?"


def _normalize_job_record(job: Dict[str, Any]) -> Dict[str, Any]:
    """Return a read-safe cron job shape for UI/API/tool/scheduler consumers.

    Older or hand-edited jobs can have nullable fields like ``prompt``,
    ``name``, or ``schedule_display``.  Keep storage untouched on read, but
    ensure consumers never crash while formatting or running those records.
    """
    normalized = _apply_skill_fields(job)
    # Retired messaging-delivery fields may still exist in old on-disk job
    # records.  They are intentionally ignored by the local-only scheduler.
    normalized.pop("deliver", None)
    normalized.pop("origin", None)
    normalized.pop("last_delivery_error", None)
    job_id = _coerce_job_text(normalized.get("id"), "unknown")
    prompt = _coerce_job_text(normalized.get("prompt"))
    normalized["id"] = job_id
    normalized["prompt"] = prompt

    name = _coerce_job_text(normalized.get("name")).strip()
    if not name:
        script = _coerce_job_text(normalized.get("script")).strip()
        label_source = (
            prompt
            or (normalized["skills"][0] if normalized.get("skills") else "")
            or script
            or job_id
            or "cron job"
        )
        name = label_source[:50].strip() or "cron job"
    normalized["name"] = name
    normalized["schedule_display"] = _schedule_display_for_job(normalized)

    state = _coerce_job_text(normalized.get("state")).strip()
    if not state:
        state = "scheduled" if normalized.get("enabled", True) else "paused"
    normalized["state"] = state

    return normalized


def _secure_dir(path: Path):
    """Set directory to owner-only access (0700). No-op on Windows."""
    try:
        os.chmod(path, 0o700)
    except (OSError, NotImplementedError):
        pass  # Windows or other platforms where chmod is not supported


def _secure_file(path: Path):
    """Set file to owner-only read/write (0600). No-op on Windows."""
    try:
        if path.exists():
            os.chmod(path, 0o600)
    except (OSError, NotImplementedError):
        pass


def ensure_dirs():
    """Ensure cron directories exist with secure permissions."""
    CRON_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    _secure_dir(CRON_DIR)
    _secure_dir(OUTPUT_DIR)


def _atomic_write_epoch(path: Path) -> None:
    """Atomically write the current epoch time to a cron health marker."""
    ensure_dirs()
    fd, tmp_path = tempfile.mkstemp(
        dir=str(CRON_DIR), suffix=".tmp", prefix=".ticker_"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(str(time.time()))
            handle.flush()
            os.fsync(handle.fileno())
        atomic_replace(tmp_path, path)
        _secure_file(path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def record_ticker_heartbeat(*, success: bool = False) -> None:
    """Best-effort liveness marker for the desktop cron ticker.

    A separate successful-tick marker lets status distinguish a dead ticker
    from one that is alive but failing on every iteration.
    """
    try:
        _atomic_write_epoch(TICKER_HEARTBEAT_FILE)
    except Exception:
        logger.debug("Unable to record cron ticker heartbeat", exc_info=True)
    if success:
        try:
            _atomic_write_epoch(TICKER_SUCCESS_FILE)
        except Exception:
            logger.debug("Unable to record cron ticker success", exc_info=True)


def _epoch_file_age(path: Path) -> Optional[float]:
    try:
        raw = path.read_text(encoding="utf-8").strip()
        return max(0.0, time.time() - float(raw))
    except Exception:
        return None


def get_ticker_heartbeat_age() -> Optional[float]:
    """Seconds since the ticker last iterated, or ``None`` when unknown."""
    return _epoch_file_age(TICKER_HEARTBEAT_FILE)


def get_ticker_success_age() -> Optional[float]:
    """Seconds since the ticker last completed a clean tick, if known."""
    return _epoch_file_age(TICKER_SUCCESS_FILE)


# =============================================================================
# Schedule Parsing
# =============================================================================

def parse_duration(s: str) -> int:
    """
    Parse duration string into minutes.
    
    Examples:
        "30m" → 30
        "2h" → 120
        "1d" → 1440
    """
    s = s.strip().lower()
    match = re.match(r'^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$', s)
    if not match:
        raise ValueError(f"Invalid duration: '{s}'. Use format like '30m', '2h', or '1d'")
    
    value = int(match.group(1))
    unit = match.group(2)[0]  # First char: m, h, or d
    
    multipliers = {'m': 1, 'h': 60, 'd': 1440}
    return value * multipliers[unit]


def parse_schedule(schedule: str) -> Dict[str, Any]:
    """
    Parse schedule string into structured format.
    
    Returns dict with:
        - kind: "once" | "interval" | "cron"
        - For "once": "run_at" (ISO timestamp)
        - For "interval": "minutes" (int)
        - For "cron": "expr" (cron expression)
    
    Examples:
        "30m"              → once in 30 minutes
        "2h"               → once in 2 hours
        "every 30m"        → recurring every 30 minutes
        "every 2h"         → recurring every 2 hours
        "0 9 * * *"        → cron expression
        "2026-02-03T14:00" → once at timestamp
    """
    schedule = schedule.strip()
    original = schedule
    schedule_lower = schedule.lower()
    
    # "every X" pattern → recurring interval
    if schedule_lower.startswith("every "):
        duration_str = schedule[6:].strip()
        minutes = parse_duration(duration_str)
        return {
            "kind": "interval",
            "minutes": minutes,
            "display": f"every {minutes}m"
        }
    
    # Check for cron expression (5 or 6 space-separated fields)
    # Cron fields: minute hour day month weekday [year]
    parts = schedule.split()
    if len(parts) >= 5 and all(
        re.match(r'^[\d\*\-,/]+$', p) for p in parts[:5]
    ):
        if not HAS_CRONITER:
            raise ValueError("Cron expressions require 'croniter' package. Install with: pip install croniter")
        # Validate cron expression
        try:
            croniter(schedule)
        except Exception as e:
            raise ValueError(f"Invalid cron expression '{schedule}': {e}")
        return {
            "kind": "cron",
            "expr": schedule,
            "display": schedule
        }
    
    # ISO timestamp (contains T or looks like date)
    if 'T' in schedule or re.match(r'^\d{4}-\d{2}-\d{2}', schedule):
        try:
            # Parse and validate
            dt = datetime.fromisoformat(schedule.replace('Z', '+00:00'))
            # Make naive timestamps timezone-aware at parse time so the stored
            # value uses the same configured timezone as due-job evaluation.
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=_fan_now().tzinfo)
            return {
                "kind": "once",
                "run_at": dt.isoformat(),
                "display": f"once at {dt.strftime('%Y-%m-%d %H:%M')}"
            }
        except ValueError as e:
            raise ValueError(f"Invalid timestamp '{schedule}': {e}")
    
    # Duration like "30m", "2h", "1d" → one-shot from now
    try:
        minutes = parse_duration(schedule)
        run_at = _fan_now() + timedelta(minutes=minutes)
        return {
            "kind": "once",
            "run_at": run_at.isoformat(),
            "display": f"once in {original}"
        }
    except ValueError:
        pass
    
    raise ValueError(
        f"Invalid schedule '{original}'. Use:\n"
        f"  - Duration: '30m', '2h', '1d' (one-shot)\n"
        f"  - Interval: 'every 30m', 'every 2h' (recurring)\n"
        f"  - Cron: '0 9 * * *' (cron expression)\n"
        f"  - Timestamp: '2026-02-03T14:00:00' (one-shot at time)"
    )


def _ensure_aware(dt: datetime) -> datetime:
    """Return a timezone-aware datetime in Fan configured timezone.

    Backward compatibility:
    - Older stored timestamps may be naive.
    - Naive values are interpreted as *system-local wall time* (the timezone
      `datetime.now()` used when they were created), then converted to the
      configured Fan timezone.

    This preserves relative ordering for legacy naive timestamps across
    timezone changes and avoids false not-due results.
    """
    target_tz = _fan_now().tzinfo
    if dt.tzinfo is None:
        local_tz = datetime.now().astimezone().tzinfo
        return dt.replace(tzinfo=local_tz).astimezone(target_tz)
    return dt.astimezone(target_tz)


def _timezone_offset_mismatch(stored: datetime, current: datetime) -> bool:
    """Whether two aware timestamps carry different UTC offsets."""
    if stored.tzinfo is None or current.tzinfo is None:
        return False
    return stored.utcoffset() != current.utcoffset()


def _stored_wall_clock_is_future(stored: datetime, current: datetime) -> bool:
    """Whether the stored local wall-clock value has not arrived yet."""
    return stored.replace(tzinfo=None) > current.replace(tzinfo=None)


def _recoverable_oneshot_run_at(
    schedule: Dict[str, Any],
    now: datetime,
    *,
    last_run_at: Optional[str] = None,
) -> Optional[str]:
    """Return a one-shot run time if it is still eligible to fire.

    One-shot jobs get a small grace window so jobs created a few seconds after
    their requested minute still run on the next tick. Once a one-shot has
    already run, it is never eligible again.
    """
    if schedule.get("kind") != "once":
        return None
    if last_run_at:
        return None

    run_at = schedule.get("run_at")
    if not run_at:
        return None

    run_at_dt = _ensure_aware(datetime.fromisoformat(run_at))
    if run_at_dt >= now - timedelta(seconds=ONESHOT_GRACE_SECONDS):
        return run_at
    return None


def _compute_grace_seconds(schedule: dict) -> int:
    """Compute how late a job can be and still catch up instead of fast-forwarding.

    Uses half the schedule period, clamped between 120 seconds and 2 hours.
    This ensures daily jobs can catch up if missed by up to 2 hours,
    while frequent jobs (every 5-10 min) still fast-forward quickly.
    """
    MIN_GRACE = 120
    MAX_GRACE = 7200  # 2 hours

    kind = schedule.get("kind")

    if kind == "interval":
        period_seconds = schedule.get("minutes", 1) * 60
        grace = period_seconds // 2
        return max(MIN_GRACE, min(grace, MAX_GRACE))

    if kind == "cron" and HAS_CRONITER:
        try:
            now = _fan_now()
            cron = croniter(schedule["expr"], now)
            first = cron.get_next(datetime)
            second = cron.get_next(datetime)
            period_seconds = int((second - first).total_seconds())
            grace = period_seconds // 2
            return max(MIN_GRACE, min(grace, MAX_GRACE))
        except Exception:
            pass

    return MIN_GRACE


def compute_next_run(schedule: Dict[str, Any], last_run_at: Optional[str] = None) -> Optional[str]:
    """
    Compute the next run time for a schedule.

    Returns ISO timestamp string, or None if no more runs.
    """
    now = _fan_now()

    if schedule["kind"] == "once":
        return _recoverable_oneshot_run_at(schedule, now, last_run_at=last_run_at)

    elif schedule["kind"] == "interval":
        minutes = schedule["minutes"]
        if last_run_at:
            # Next run is last_run + interval
            last = _ensure_aware(datetime.fromisoformat(last_run_at))
            next_run = last + timedelta(minutes=minutes)
        else:
            # First run is now + interval
            next_run = now + timedelta(minutes=minutes)
        return next_run.isoformat()

    elif schedule["kind"] == "cron":
        if not HAS_CRONITER:
            logger.warning(
                "Cannot compute next run for cron schedule %r: 'croniter' is "
                "not installed. croniter is a core dependency as of v0.9.x; "
                "reinstall fan-agent or run 'pip install croniter' in your "
                "runtime env.",
                schedule.get("expr"),
            )
            return None
        # Use last_run_at as the croniter base when available, consistent
        # with interval jobs.  This ensures that after a crash/restart,
        # the next run is anchored to the actual last execution time
        # rather than to an arbitrary restart time.
        base_time = now
        if last_run_at:
            base_time = _ensure_aware(datetime.fromisoformat(last_run_at))
        cron = croniter(schedule["expr"], base_time)
        next_run = cron.get_next(datetime)
        return next_run.isoformat()

    return None


# =============================================================================
# Job CRUD Operations
# =============================================================================

def load_jobs() -> List[Dict[str, Any]]:
    """Load all jobs from storage."""
    ensure_dirs()
    if not JOBS_FILE.exists():
        return []

    _strict_retry = False  # track whether we used the strict=False fallback

    try:
        # Windows Notepad and PowerShell 5.1 may write a leading UTF-8 BOM.
        # utf-8-sig accepts both BOM-prefixed and regular UTF-8 files.
        with open(JOBS_FILE, 'r', encoding='utf-8-sig') as f:
            data = json.load(f)
    except json.JSONDecodeError:
        # Retry with strict=False to handle bare control chars in string values
        _strict_retry = True
        try:
            with open(JOBS_FILE, 'r', encoding='utf-8-sig') as f:
                data = json.loads(f.read(), strict=False)
        except Exception as e:
            logger.error("Failed to auto-repair jobs.json: %s", e)
            raise RuntimeError(f"Cron database corrupted and unrepairable: {e}") from e
    except IOError as e:
        logger.error("IOError reading jobs.json: %s", e)
        raise RuntimeError(f"Failed to read cron database: {e}") from e

    # Validate the top-level JSON shape: accept a dict (expected) or a bare
    # list (auto-repair). Anything else (str/number/null) is corruption that
    # would otherwise raise an uncaught AttributeError on ``.get()`` and take
    # down the whole cron subsystem.
    if isinstance(data, dict):
        jobs = data.get("jobs", [])
        if _strict_retry and jobs:
            # Hit control-character corruption — rewrite with proper escaping.
            save_jobs(jobs)
            logger.warning("Auto-repaired jobs.json (had invalid control characters)")
        return jobs
    if isinstance(data, list):
        # Bare array — likely saved/edited outside save_jobs(). Wrap it back
        # into the expected {"jobs": [...]} structure.
        if data:
            save_jobs(data)
            logger.warning("Auto-repaired jobs.json (bare list wrapped as dict)")
        return data

    raise RuntimeError(
        f"Cron database corrupted: expected {{'jobs': [...]}}, got {type(data).__name__}"
    )


def _save_jobs_unlocked(jobs: List[Dict[str, Any]]):
    """Save all jobs to storage. Caller must hold _jobs_lock()."""
    ensure_dirs()
    sanitized_jobs = []
    for job in jobs:
        sanitized = dict(job)
        sanitized.pop("deliver", None)
        sanitized.pop("origin", None)
        sanitized.pop("last_delivery_error", None)
        sanitized_jobs.append(sanitized)
    fd, tmp_path = tempfile.mkstemp(dir=str(JOBS_FILE.parent), suffix='.tmp', prefix='.jobs_')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump({"jobs": sanitized_jobs, "updated_at": _fan_now().isoformat()}, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        atomic_replace(tmp_path, JOBS_FILE)
        _secure_file(JOBS_FILE)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def save_jobs(jobs: List[Dict[str, Any]]):
    """Save all jobs to storage."""
    with _jobs_lock():
        _save_jobs_unlocked(jobs)


def _normalize_workdir(workdir: Optional[str]) -> Optional[str]:
    """Normalize and validate a cron job workdir.

    Rules:
      - Empty / None → None (feature off, preserves old behaviour).
      - ``~`` is expanded.  Relative paths are rejected — cron jobs run detached
        from any shell cwd, so relative paths have no stable meaning.
      - The path must exist and be a directory at create/update time.  We do
        NOT re-check at run time (a user might briefly unmount the dir; the
        scheduler will just fall back to old behaviour with a logged warning).

    Returns the absolute path string, or None when disabled.
    Raises ValueError on invalid input.
    """
    if workdir is None:
        return None
    raw = str(workdir).strip()
    if not raw:
        return None
    expanded = Path(raw).expanduser()
    if not expanded.is_absolute():
        raise ValueError(
            f"Cron workdir must be an absolute path (got {raw!r}). "
            f"Cron jobs run detached from any shell cwd, so relative paths are ambiguous."
        )
    resolved = expanded.resolve()
    if not resolved.exists():
        raise ValueError(f"Cron workdir does not exist: {resolved}")
    if not resolved.is_dir():
        raise ValueError(f"Cron workdir is not a directory: {resolved}")
    return str(resolved)


def _resolve_default_model_snapshot() -> Optional[str]:
    """Return the effective default model used by an unpinned cron job."""
    try:
        from fan_cli.config import load_config_readonly

        config = load_config_readonly() or {}
        model_config = config.get("model") or {}
        if isinstance(model_config, str):
            return model_config.strip() or None
        if isinstance(model_config, dict):
            default = model_config.get("default") or model_config.get("model")
            return str(default).strip() if default else None
    except Exception:
        pass
    return None


def create_job(
    prompt: Optional[str],
    schedule: str,
    name: Optional[str] = None,
    repeat: Optional[int] = None,
    skill: Optional[str] = None,
    skills: Optional[List[str]] = None,
    model: Optional[str] = None,
    provider: Optional[str] = None,
    base_url: Optional[str] = None,
    script: Optional[str] = None,
    context_from: Optional[Union[str, List[str]]] = None,
    enabled_toolsets: Optional[List[str]] = None,
    workdir: Optional[str] = None,
    no_agent: bool = False,
) -> Dict[str, Any]:
    """
    Create a new cron job.

    Args:
        prompt: The prompt to run (must be self-contained, or a task instruction when skill is set).
                Ignored when ``no_agent=True`` except as an optional name hint.
        schedule: Schedule string (see parse_schedule)
        name: Optional friendly name
        repeat: How many times to run (None = forever, 1 = once)
        skill: Optional legacy single skill name to load before running the prompt
        skills: Optional ordered list of skills to load before running the prompt
        model: Optional per-job model override
        provider: Optional per-job provider override
        base_url: Optional per-job base URL override
        script: Optional path to a script whose stdout feeds the job. With
                ``no_agent=True`` the script IS the job — its stdout is
                saved verbatim. Without ``no_agent``, its stdout is
                injected into the agent's prompt as context (data-collection /
                change-detection pattern). Paths resolve under
                ~/.fan/scripts/; ``.sh`` / ``.bash`` files run via bash,
                anything else via Python.
        context_from: Optional job ID (or list of job IDs) whose most recent output
                      is injected into the prompt as context before each run.
                      Useful for chaining cron jobs: job A finds data, job B processes it.
        enabled_toolsets: Optional list of toolset names to restrict the agent to.
                          When set, only tools from these toolsets are loaded, reducing
                          token overhead. When omitted, all default tools are loaded.
                          Ignored when ``no_agent=True``.
        workdir: Optional absolute path.  When set, the job runs as if launched
                from that directory: AGENTS.md / CLAUDE.md / .cursorrules from
                that directory are injected into the system prompt, and the
                terminal/file/code_exec tools use it as their working directory
                (via TERMINAL_CWD).  When unset, the old behaviour is preserved
                (no context files injected, tools use the scheduler's cwd).
                With ``no_agent=True``, ``workdir`` is still applied as the
                script's cwd so relative paths inside the script behave
                predictably.
        no_agent: When True, skip the agent entirely — run ``script`` on schedule
                and save its stdout directly. Empty stdout produces an empty
                run record. Requires ``script`` to be set. Ideal for classic
                watchdogs and periodic checks that don't need LLM reasoning.

    Returns:
        The created job dict
    """
    parsed_schedule = parse_schedule(schedule)
    initial_next_run = compute_next_run(parsed_schedule)
    if initial_next_run is None and parsed_schedule.get("kind") == "once":
        run_at = parsed_schedule.get("run_at", "unknown")
        raise ValueError(
            f"Requested one-shot time {run_at} is more than "
            f"{ONESHOT_GRACE_SECONDS}s in the past and cannot be scheduled."
        )

    # Normalize repeat: treat 0 or negative values as None (infinite)
    if repeat is not None and repeat <= 0:
        repeat = None

    # Auto-set repeat=1 for one-shot schedules if not specified
    if parsed_schedule["kind"] == "once" and repeat is None:
        repeat = 1

    job_id = uuid.uuid4().hex[:12]
    now = _fan_now().isoformat()

    normalized_skills = _normalize_skill_list(skill, skills)
    normalized_model = str(model).strip() if isinstance(model, str) else None
    normalized_provider = str(provider).strip() if isinstance(provider, str) else None
    normalized_base_url = str(base_url).strip().rstrip("/") if isinstance(base_url, str) else None
    normalized_model = normalized_model or None
    normalized_provider = normalized_provider or None
    normalized_base_url = normalized_base_url or None
    normalized_script = str(script).strip() if isinstance(script, str) else None
    normalized_script = normalized_script or None
    normalized_toolsets = [str(t).strip() for t in enabled_toolsets if str(t).strip()] if enabled_toolsets else None
    normalized_toolsets = normalized_toolsets or None
    normalized_workdir = _normalize_workdir(workdir)
    normalized_no_agent = bool(no_agent)

    # no_agent jobs are meaningless without a script — the script IS the job.
    # Surface this as a clear ValueError at create time so bad configs never
    # reach the scheduler.
    if normalized_no_agent and not normalized_script:
        raise ValueError(
            "no_agent=True requires a script — with no agent and no script "
            "there is nothing for the job to run."
        )

    # Normalize context_from: accept str or list of str, store as list or None
    if isinstance(context_from, str):
        context_from = [context_from.strip()] if context_from.strip() else None
    elif isinstance(context_from, list):
        context_from = [str(j).strip() for j in context_from if str(j).strip()] or None
    else:
        context_from = None

    prompt_text = _coerce_job_text(prompt)
    label_source = (prompt_text or (normalized_skills[0] if normalized_skills else None) or (normalized_script if normalized_no_agent else None)) or "cron job"

    # An unpinned job follows the global inference configuration. Capture that
    # resolution at creation so a later provider/model switch cannot silently
    # turn a scheduled task into unintended spend or different behavior.
    provider_snapshot: Optional[str] = None
    model_snapshot: Optional[str] = None
    if not normalized_no_agent:
        if normalized_provider is None:
            try:
                from fan_cli.runtime_provider import resolve_runtime_provider

                runtime_kwargs: dict[str, Any] = {"requested": None}
                if normalized_base_url:
                    runtime_kwargs["explicit_base_url"] = normalized_base_url
                runtime = resolve_runtime_provider(**runtime_kwargs)
                provider_snapshot = (
                    str(runtime.get("provider") or "").strip().lower() or None
                )
            except Exception:
                pass
        if normalized_model is None:
            model_snapshot = _resolve_default_model_snapshot()

    job = {
        "id": job_id,
        "name": name or label_source[:50].strip(),
        "prompt": prompt_text,
        "skills": normalized_skills,
        "skill": normalized_skills[0] if normalized_skills else None,
        "model": normalized_model,
        "provider": normalized_provider,
        "provider_snapshot": provider_snapshot,
        "model_snapshot": model_snapshot,
        "base_url": normalized_base_url,
        "script": normalized_script,
        "no_agent": normalized_no_agent,
        "context_from": context_from,
        "schedule": parsed_schedule,
        "schedule_display": parsed_schedule.get("display", schedule),
        "repeat": {
            "times": repeat,  # None = forever
            "completed": 0
        },
        "enabled": True,
        "state": "scheduled",
        "paused_at": None,
        "paused_reason": None,
        "created_at": now,
        "next_run_at": initial_next_run,
        "last_run_at": None,
        "last_status": None,
        "last_error": None,
        "enabled_toolsets": normalized_toolsets,
        "workdir": normalized_workdir,
    }

    with _jobs_lock():
        jobs = load_jobs()
        jobs.append(job)
        save_jobs(jobs)

    return job


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    """Get a job by ID."""
    jobs = load_jobs()
    for job in jobs:
        if job["id"] == job_id:
            return _normalize_job_record(job)
    return None


class AmbiguousJobReference(LookupError):
    """Raised when a job name matches more than one job."""

    def __init__(self, ref: str, matches: List[Dict[str, Any]]):
        self.ref = ref
        self.matches = matches
        ids = ", ".join(m["id"] for m in matches)
        super().__init__(
            f"Job name '{ref}' is ambiguous — matches {len(matches)} jobs: {ids}. "
            f"Use the job ID instead."
        )


def resolve_job_ref(ref: str) -> Optional[Dict[str, Any]]:
    """Resolve a job reference (ID or name) to a job record.

    - Exact ID match wins (works even if a different job's name equals this ID).
    - Otherwise, case-insensitive name match.
    - If a name matches more than one job, raises AmbiguousJobReference so the
      caller can surface the matching IDs rather than silently picking one.
    """
    if not ref:
        return None
    jobs = load_jobs()
    for job in jobs:
        if job["id"] == ref:
            return _normalize_job_record(job)
    ref_lower = ref.lower()
    name_matches = [j for j in jobs if (j.get("name") or "").lower() == ref_lower]
    if not name_matches:
        return None
    if len(name_matches) > 1:
        raise AmbiguousJobReference(
            ref, [_normalize_job_record(j) for j in name_matches]
        )
    return _normalize_job_record(name_matches[0])


def list_jobs(include_disabled: bool = False) -> List[Dict[str, Any]]:
    """List all jobs, optionally including disabled ones."""
    jobs = [_normalize_job_record(j) for j in load_jobs()]
    if not include_disabled:
        jobs = [j for j in jobs if j.get("enabled", True)]
    return jobs


def update_job(job_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Update a job by ID, refreshing derived schedule fields when needed."""
    # Block mutation of immutable fields. ``id`` in particular is a filesystem
    # path component under OUTPUT_DIR — letting an update change it leaks
    # path-escape values into output writes/deletes.
    bad_fields = _IMMUTABLE_JOB_FIELDS.intersection(updates or {})
    if bad_fields:
        raise ValueError(
            f"Cron job field(s) cannot be updated: {', '.join(sorted(bad_fields))}"
        )

    with _jobs_lock():
        jobs = load_jobs()
        for i, job in enumerate(jobs):
            if job["id"] != job_id:
                continue

            # Validate / normalize workdir if present in updates.  Empty string
            # or None both mean "clear the field" (restore old behaviour).
            if "workdir" in updates:
                _wd = updates["workdir"]
                if _wd in {None, "", False}:
                    updates["workdir"] = None
                else:
                    updates["workdir"] = _normalize_workdir(_wd)

            updated = _apply_skill_fields({**job, **updates})
            schedule_changed = "schedule" in updates

            if "skills" in updates or "skill" in updates:
                normalized_skills = _normalize_skill_list(updated.get("skill"), updated.get("skills"))
                updated["skills"] = normalized_skills
                updated["skill"] = normalized_skills[0] if normalized_skills else None

            if schedule_changed:
                updated_schedule = updated["schedule"]
                # The API may pass schedule as a raw string (e.g. "every 10m")
                # instead of a pre-parsed dict.  Normalize it the same way
                # create_job() does so downstream code can call .get() safely.
                if isinstance(updated_schedule, str):
                    updated_schedule = parse_schedule(updated_schedule)
                    updated["schedule"] = updated_schedule
                updated["schedule_display"] = updates.get(
                    "schedule_display",
                    updated_schedule.get("display", updated.get("schedule_display")),
                )
                if updated.get("state") != "paused":
                    updated_next_run = compute_next_run(updated_schedule)
                    if (
                        updated_next_run is None
                        and updated_schedule.get("kind") == "once"
                    ):
                        run_at = updated_schedule.get("run_at", "unknown")
                        raise ValueError(
                            f"Requested one-shot time {run_at} is more than "
                            f"{ONESHOT_GRACE_SECONDS}s in the past and cannot be scheduled."
                        )
                    updated["next_run_at"] = updated_next_run

            if updated.get("enabled", True) and updated.get("state") != "paused" and not updated.get("next_run_at"):
                next_run = compute_next_run(updated["schedule"])
                if next_run is None and updated["schedule"].get("kind") == "once":
                    run_at = updated["schedule"].get("run_at", "unknown")
                    raise ValueError(
                        f"Requested one-shot time {run_at} is in the past "
                        f"(grace window: {ONESHOT_GRACE_SECONDS}s) and cannot be scheduled."
                    )
                updated["next_run_at"] = next_run

            jobs[i] = updated
            save_jobs(jobs)
            return _normalize_job_record(jobs[i])
    return None


def pause_job(job_id: str, reason: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Pause a job without deleting it. Accepts a job ID or name."""
    job = resolve_job_ref(job_id)
    if not job:
        return None
    return update_job(
        job["id"],
        {
            "enabled": False,
            "state": "paused",
            "paused_at": _fan_now().isoformat(),
            "paused_reason": reason,
        },
    )


def resume_job(job_id: str) -> Optional[Dict[str, Any]]:
    """Resume a paused job and compute the next future run from now. Accepts a job ID or name."""
    job = resolve_job_ref(job_id)
    if not job:
        return None

    next_run_at = compute_next_run(job["schedule"])
    if next_run_at is None and job["schedule"].get("kind") == "once":
        run_at = job["schedule"].get("run_at", "unknown")
        raise ValueError(
            f"Cannot resume: one-shot time {run_at} is in the past "
            f"(grace window: {ONESHOT_GRACE_SECONDS}s) and will never fire."
        )
    return update_job(
        job["id"],
        {
            "enabled": True,
            "state": "scheduled",
            "paused_at": None,
            "paused_reason": None,
            "next_run_at": next_run_at,
        },
    )


def trigger_job(job_id: str) -> Optional[Dict[str, Any]]:
    """Schedule a job to run on the next scheduler tick. Accepts a job ID or name."""
    job = resolve_job_ref(job_id)
    if not job:
        return None
    return update_job(
        job["id"],
        {
            "enabled": True,
            "state": "scheduled",
            "paused_at": None,
            "paused_reason": None,
            "next_run_at": _fan_now().isoformat(),
        },
    )


def remove_job(job_id: str) -> bool:
    """Remove a job by ID or name."""
    job = resolve_job_ref(job_id)
    if not job:
        return False
    canonical_id = job["id"]
    with _jobs_lock():
        jobs = load_jobs()
        original_len = len(jobs)
        jobs = [j for j in jobs if j["id"] != canonical_id]
        if len(jobs) < original_len:
            # Resolve the output dir BEFORE saving so a legacy unsafe ID (e.g.
            # left over from before the create-time guard) fails closed without
            # half-applying the removal.
            job_output_dir = _job_output_dir(canonical_id)
            save_jobs(jobs)
            # Clean up output directory to prevent orphaned dirs accumulating
            if job_output_dir.exists():
                shutil.rmtree(job_output_dir)
            return True
    return False


def mark_job_run(job_id: str, success: bool, error: Optional[str] = None,
                 claim_token: Optional[str] = None) -> bool:
    """
    Mark a job as having been run.
    
    Updates last_run_at, last_status, increments completed count,
    computes next_run_at, and auto-deletes if repeat limit reached.

    """
    with _jobs_lock():
        jobs = load_jobs()
        for i, job in enumerate(jobs):
            if job["id"] == job_id:
                current_claim = job.get("run_claim")
                current_token = _run_claim_token(current_claim)
                supplied_token = str(claim_token or "").strip()
                if current_token and current_token != supplied_token:
                    logger.warning(
                        "mark_job_run: refusing stale/non-owner completion for "
                        "job %s (claim token mismatch)",
                        job_id,
                    )
                    return False
                if supplied_token and current_token != supplied_token:
                    logger.warning(
                        "mark_job_run: refusing completion for job %s because "
                        "its run claim was replaced or removed",
                        job_id,
                    )
                    return False

                schedule_kind = job.get("schedule", {}).get("kind")
                claimed_recurring = bool(
                    supplied_token
                    and current_token == supplied_token
                    and schedule_kind in {"cron", "interval"}
                )
                # Clear only the claim this completion owns. A replacement
                # owner can never be erased by a late worker.
                job.pop("run_claim", None)
                now = _fan_now().isoformat()
                job["last_run_at"] = now
                job["last_status"] = "ok" if success else "error"
                job["last_error"] = error if not success else None
                # Increment completed count
                if job.get("repeat"):
                    job["repeat"]["completed"] = job["repeat"].get("completed", 0) + 1
                    
                    # Check if we've hit the repeat limit
                    times = job["repeat"].get("times")
                    completed = job["repeat"]["completed"]
                    if times is not None and times > 0 and completed >= times:
                        # Remove the job (limit reached)
                        jobs.pop(i)
                        save_jobs(jobs)
                        return True
                
                # A claimed recurring fire already advanced next_run_at in the
                # same CAS transaction that won execution. Preserve that exact
                # value so one fire advances the schedule only once.
                if not claimed_recurring:
                    job["next_run_at"] = compute_next_run(job["schedule"], now)

                # If no next run, decide whether this is terminal completion
                # (one-shot) or a transient failure (recurring schedule couldn't
                # compute — e.g. 'croniter' missing from the runtime env).
                # Recurring jobs must NEVER be silently disabled: that turns a
                # missing runtime dep into "job completed" and the user's
                # schedule quietly goes off. See issue #16265.
                if job["next_run_at"] is None:
                    kind = job.get("schedule", {}).get("kind")
                    if kind in {"cron", "interval"}:
                        job["state"] = "error"
                        if not job.get("last_error"):
                            job["last_error"] = (
                                "Failed to compute next run for recurring "
                                "schedule (is the 'croniter' package "
                                "installed in the backend's Python env?)"
                            )
                        logger.error(
                            "Job '%s' (%s) could not compute next_run_at; "
                            "leaving enabled and marking state=error so the "
                            "job is not silently disabled.",
                            job.get("name", job["id"]),
                            kind,
                        )
                    else:
                        job["enabled"] = False
                        job["state"] = "completed"
                elif job.get("state") != "paused":
                    job["state"] = "scheduled"

                save_jobs(jobs)
                return True

        logger.warning("mark_job_run: job_id %s not found, skipping save", job_id)
        return False


def advance_next_run(job_id: str) -> bool:
    """Preemptively advance next_run_at for a recurring job before execution.

    Call this BEFORE run_job() so that if the process crashes mid-execution,
    the job won't re-fire after a backend restart. This converts the
    scheduler from at-least-once to at-most-once for recurring jobs — missing
    one run is far better than firing dozens of times in a crash loop.

    One-shot jobs are left unchanged so they can still retry on restart.

    Returns True if next_run_at was advanced, False otherwise.
    """
    with _jobs_lock():
        jobs = load_jobs()
        for job in jobs:
            if job["id"] == job_id:
                kind = job.get("schedule", {}).get("kind")
                if kind not in {"cron", "interval"}:
                    return False
                now = _fan_now().isoformat()
                new_next = compute_next_run(job["schedule"], now)
                if new_next and new_next != job.get("next_run_at"):
                    job["next_run_at"] = new_next
                    save_jobs(jobs)
                    return True
                return False
        return False


def _run_claim_token(claim: Any) -> str:
    if not isinstance(claim, dict):
        return ""
    return str(claim.get("token") or "").strip()


def _run_claim_is_active(claim: Any, now: Optional[datetime] = None) -> bool:
    """Return whether a stored run claim still owns its recovery lease."""
    if not _run_claim_token(claim):
        return False
    try:
        expires_at = str(claim.get("lease_expires_at") or "").strip()
        if not expires_at:
            return False
        expiry = _ensure_aware(datetime.fromisoformat(expires_at))
        if expiry > (now or _fan_now()):
            return True
    except (TypeError, ValueError):
        return False

    # Sleep/wake can pause both the worker and heartbeat longer than the
    # nominal lease. On the same machine, a matching PID + process birth time
    # proves the owner process is still alive, so do not duplicate a live long
    # task merely because wall-clock time jumped. A crashed process fails this
    # check and remains recoverable. Other hosts fall back to the lease.
    return _run_claim_owner_is_alive(claim)


def _run_claim_owner_is_alive(claim: Any) -> bool:
    if not isinstance(claim, dict):
        return False
    try:
        import socket

        if str(claim.get("owner_host") or "") != socket.gethostname():
            return False
        owner_pid = int(claim.get("owner_pid"))
        owner_started_at = float(claim.get("owner_process_started_at"))

        import psutil

        process = psutil.Process(owner_pid)
        if not process.is_running() or process.status() == psutil.STATUS_ZOMBIE:
            return False
        return abs(process.create_time() - owner_started_at) < 1.0
    except ImportError:
        return False
    except Exception as exc:
        # A permissions failure means the PID exists but cannot be inspected;
        # prefer deferring a duplicate execution. Missing/reused PIDs normally
        # fail before this point or produce a different creation time.
        try:
            import psutil

            if isinstance(exc, psutil.AccessDenied):
                return True
        except Exception:
            pass
        return False


def _run_claim_owner_metadata() -> Dict[str, Any]:
    """Return process identity metadata used for safe sleep/wake recovery."""
    try:
        import socket

        hostname = socket.gethostname()
    except Exception:
        hostname = "unknown"
    started_at: Optional[float] = None
    try:
        import psutil

        started_at = psutil.Process(os.getpid()).create_time()
    except Exception:
        pass
    return {
        "owner": f"{hostname}:{os.getpid()}",
        "owner_host": hostname,
        "owner_pid": os.getpid(),
        "owner_process_started_at": started_at,
    }


def claim_job_for_fire(
    job_id: str,
    *,
    expected_scheduled_for: str,
    lease_seconds: int = RUN_CLAIM_LEASE_SECONDS,
) -> Optional[Dict[str, Any]]:
    """Atomically claim one due fire and return its claimed job snapshot.

    The jobs-file lock is the compare-and-set boundary. The live record is
    revalidated against the due-scan's exact ``next_run_at`` value so a pause,
    edit, trigger, or competing scheduler cannot execute a stale snapshot.
    Recurring schedules advance in this same transaction; one-shots retain
    their due timestamp and are fenced solely by the claim until completion.
    """
    scheduled_for = str(expected_scheduled_for or "").strip()
    if not scheduled_for:
        return None

    try:
        lease_seconds = max(60, int(lease_seconds))
    except (TypeError, ValueError, OverflowError):
        lease_seconds = RUN_CLAIM_LEASE_SECONDS

    with _jobs_lock():
        jobs = load_jobs()
        for job in jobs:
            if not isinstance(job, dict) or job.get("id") != job_id:
                continue
            if not job.get("enabled", True) or job.get("state") == "paused":
                return None

            live_scheduled_for = str(job.get("next_run_at") or "").strip()
            if live_scheduled_for != scheduled_for:
                return None

            now = _fan_now()
            try:
                scheduled_dt = _ensure_aware(datetime.fromisoformat(live_scheduled_for))
            except (TypeError, ValueError):
                logger.warning(
                    "Job '%s' has invalid next_run_at %r; refusing run claim",
                    job.get("name", job_id),
                    live_scheduled_for,
                )
                return None
            if scheduled_dt > now:
                return None

            schedule = job.get("schedule")
            if not isinstance(schedule, dict):
                return None
            kind = schedule.get("kind")

            existing_claim = job.get("run_claim")
            if _run_claim_is_active(existing_claim, now):
                return None

            # Re-check the recurring missed-window policy inside the CAS. A
            # stale recurring fire still runs once, while its accumulated
            # missed slots are collapsed to one future occurrence.
            catch_up_next = None
            if (
                kind in {"cron", "interval"}
                and (now - scheduled_dt).total_seconds()
                > _compute_grace_seconds(schedule)
            ):
                catch_up_next = compute_next_run(schedule, now.isoformat())
                if not catch_up_next:
                    return None

            token = uuid.uuid4().hex
            now_iso = now.isoformat()
            claim = {
                "token": token,
                "scheduled_for": scheduled_for,
                "claimed_at": now_iso,
                "heartbeat_at": now_iso,
                "lease_expires_at": (
                    now + timedelta(seconds=lease_seconds)
                ).isoformat(),
                **_run_claim_owner_metadata(),
            }

            if kind in {"cron", "interval"}:
                new_next = catch_up_next or compute_next_run(schedule, now_iso)
                if not new_next:
                    logger.error(
                        "Job '%s' could not advance its recurring schedule; "
                        "refusing run claim",
                        job.get("name", job_id),
                    )
                    return None
                job["next_run_at"] = new_next

            if existing_claim:
                logger.warning(
                    "Recovering expired or malformed run claim for job '%s' "
                    "(previous owner=%s)",
                    job.get("name", job_id),
                    existing_claim.get("owner", "unknown")
                    if isinstance(existing_claim, dict)
                    else "unknown",
                )
            job["run_claim"] = claim
            _save_jobs_unlocked(jobs)
            return _normalize_job_record(copy.deepcopy(job))
        return None


def claim_job_for_immediate_fire(
    job_id: str,
    *,
    lease_seconds: int = RUN_CLAIM_LEASE_SECONDS,
) -> Optional[Dict[str, Any]]:
    """Atomically claim a manual immediate run without disturbing a live fire.

    Preparing the immediate timestamp and acquiring the claim must be one
    jobs-file transaction. Otherwise a failed claim can leave ``next_run_at``
    set to now and cause an unexpected second fire after the current owner
    finishes.
    """
    try:
        lease_seconds = max(60, int(lease_seconds))
    except (TypeError, ValueError, OverflowError):
        lease_seconds = RUN_CLAIM_LEASE_SECONDS

    with _jobs_lock():
        jobs = load_jobs()
        for job in jobs:
            if not isinstance(job, dict) or job.get("id") != job_id:
                continue

            now = _fan_now()
            existing_claim = job.get("run_claim")
            if _run_claim_is_active(existing_claim, now):
                return None

            schedule = job.get("schedule")
            if not isinstance(schedule, dict):
                return None
            kind = schedule.get("kind")
            if kind not in {"once", "cron", "interval"}:
                return None

            now_iso = now.isoformat()
            next_run_at = now_iso
            if kind in {"cron", "interval"}:
                next_run_at = compute_next_run(schedule, now_iso)
                if not next_run_at:
                    logger.error(
                        "Job '%s' could not advance its recurring schedule; "
                        "refusing immediate run claim",
                        job.get("name", job_id),
                    )
                    return None

            token = uuid.uuid4().hex
            claim = {
                "token": token,
                "scheduled_for": now_iso,
                "claimed_at": now_iso,
                "heartbeat_at": now_iso,
                "lease_expires_at": (
                    now + timedelta(seconds=lease_seconds)
                ).isoformat(),
                **_run_claim_owner_metadata(),
            }
            if existing_claim:
                logger.warning(
                    "Recovering expired or malformed run claim for immediate "
                    "job '%s' (previous owner=%s)",
                    job.get("name", job_id),
                    existing_claim.get("owner", "unknown")
                    if isinstance(existing_claim, dict)
                    else "unknown",
                )

            job.update(
                {
                    "enabled": True,
                    "state": "scheduled",
                    "paused_at": None,
                    "paused_reason": None,
                    "next_run_at": next_run_at,
                    "run_claim": claim,
                }
            )
            _save_jobs_unlocked(jobs)
            return _normalize_job_record(copy.deepcopy(job))
        return None


def renew_job_run_claim(
    job_id: str,
    claim_token: str,
    *,
    lease_seconds: int = RUN_CLAIM_LEASE_SECONDS,
) -> bool:
    """Renew a queued/running claim if and only if its owner token matches."""
    token = str(claim_token or "").strip()
    if not token:
        return False
    try:
        lease_seconds = max(60, int(lease_seconds))
    except (TypeError, ValueError, OverflowError):
        lease_seconds = RUN_CLAIM_LEASE_SECONDS

    with _jobs_lock():
        jobs = load_jobs()
        for job in jobs:
            if not isinstance(job, dict) or job.get("id") != job_id:
                continue
            claim = job.get("run_claim")
            if _run_claim_token(claim) != token:
                return False
            now = _fan_now()
            claim["heartbeat_at"] = now.isoformat()
            claim["lease_expires_at"] = (
                now + timedelta(seconds=lease_seconds)
            ).isoformat()
            _save_jobs_unlocked(jobs)
            return True
        return False


def job_run_claim_is_current(job_id: str, claim_token: str) -> bool:
    """Check claim ownership by token without treating lease expiry as loss.

    Expiry only makes a claim eligible for replacement. Until another owner
    actually wins the CAS, the original worker may still finish safely.
    """
    token = str(claim_token or "").strip()
    if not token:
        return False
    with _jobs_lock():
        for job in load_jobs():
            if isinstance(job, dict) and job.get("id") == job_id:
                return _run_claim_token(job.get("run_claim")) == token
    return False


def release_job_run_claim(job_id: str, claim_token: str) -> bool:
    """Release an unsubmitted claim without disturbing a replacement owner."""
    token = str(claim_token or "").strip()
    if not token:
        return False
    with _jobs_lock():
        jobs = load_jobs()
        for job in jobs:
            if not isinstance(job, dict) or job.get("id") != job_id:
                continue
            if _run_claim_token(job.get("run_claim")) != token:
                return False
            job.pop("run_claim", None)
            _save_jobs_unlocked(jobs)
            return True
    return False


def get_due_jobs() -> List[Dict[str, Any]]:
    """Get all jobs that are due to run now.

    A stale recurring schedule fires once now instead of being deferred
    forever. ``claim_job_for_fire`` atomically collapses accumulated missed
    slots to the next future occurrence, so catch-up never burst-fires.
    """
    with _jobs_lock():
        return _get_due_jobs_locked()


def _get_due_jobs_locked() -> List[Dict[str, Any]]:
    """Inner implementation of get_due_jobs(); must be called with _jobs_lock held."""
    now = _fan_now()
    raw_jobs = load_jobs()
    jobs: List[Dict[str, Any]] = []
    for raw_job in copy.deepcopy(raw_jobs):
        try:
            if not isinstance(raw_job, dict):
                raise TypeError(f"job record must be an object, got {type(raw_job).__name__}")
            jobs.append(_apply_skill_fields(raw_job))
        except Exception:
            logger.exception("Skipping malformed cron record during due scan")
    due = []
    needs_save = False

    for job in jobs:
        try:
            if not job.get("enabled", True):
                continue

            schedule = job.get("schedule", {})
            if not isinstance(schedule, dict):
                raise TypeError("schedule must be an object")
            job_id = job.get("id")
            if not isinstance(job_id, str) or not job_id.strip():
                raise ValueError("job id is missing")
            kind = schedule.get("kind")

            raw_record = next(
                (
                    candidate
                    for candidate in raw_jobs
                    if isinstance(candidate, dict) and candidate.get("id") == job_id
                ),
                None,
            )

            # A queued or running fire owns this job across processes. Long
            # jobs keep the lease fresh via scheduler heartbeat; an expired or
            # malformed claim is left eligible so claim_job_for_fire can
            # replace it atomically and recover from a crashed owner.
            if _run_claim_is_active(job.get("run_claim"), now):
                continue

            next_run = job.get("next_run_at")
            if not next_run:
                # One-shot jobs use a small grace window via the dedicated helper.
                recovered_next = _recoverable_oneshot_run_at(
                    schedule,
                    now,
                    last_run_at=job.get("last_run_at"),
                )
                recovery_kind = "one-shot" if recovered_next else None

                # Recover hand-edited recurring jobs whose next run disappeared.
                if not recovered_next and kind in {"cron", "interval"}:
                    recovered_next = compute_next_run(schedule, now.isoformat())
                    if recovered_next:
                        recovery_kind = kind

                if not recovered_next:
                    continue

                job["next_run_at"] = recovered_next
                next_run = recovered_next
                logger.info(
                    "Job '%s' had no next_run_at; recovering %s run at %s",
                    job.get("name", job_id),
                    recovery_kind,
                    recovered_next,
                )
                if raw_record is not None:
                    raw_record["next_run_at"] = recovered_next
                    needs_save = True

            if not isinstance(next_run, str):
                raise TypeError("next_run_at must be an ISO timestamp string")
            raw_next_run_dt = datetime.fromisoformat(next_run)
            next_run_dt = _ensure_aware(raw_next_run_dt)
            # Cron expressions represent local wall-clock intent. After a
            # configured/system timezone migration, a timestamp persisted with
            # the old offset can look due several hours early and then fire a
            # second time at the intended local hour. Repair only that precise
            # case; interval, naive, same-offset, and genuinely missed runs are
            # unchanged.
            if (
                kind == "cron"
                and next_run_dt <= now
                and _timezone_offset_mismatch(raw_next_run_dt, now)
                and _stored_wall_clock_is_future(raw_next_run_dt, now)
            ):
                repaired_next = compute_next_run(schedule, now.isoformat())
                if repaired_next:
                    logger.info(
                        "Job '%s' next_run_at offset changed (%s -> %s); "
                        "recomputing to preserve local wall-clock intent: %s",
                        job.get("name", job_id),
                        raw_next_run_dt.utcoffset(),
                        now.utcoffset(),
                        repaired_next,
                    )
                    if raw_record is not None:
                        raw_record["next_run_at"] = repaired_next
                        needs_save = True
                    continue
            if next_run_dt <= now:
                grace = _compute_grace_seconds(schedule)
                if kind in {"cron", "interval"} and (now - next_run_dt).total_seconds() > grace:
                    new_next = compute_next_run(schedule, now.isoformat())
                    if new_next:
                        logger.info(
                            "Job '%s' missed its scheduled time (%s, grace=%ds). "
                            "Running once now; claim will fast-forward the next run to %s",
                            job.get("name", job_id),
                            next_run,
                            grace,
                            new_next,
                        )

                due.append(job)
        except Exception:
            # One hand-edited/corrupt job must never starve healthy siblings or
            # kill the background ticker.  Keep the record untouched so the
            # operator can inspect and repair it.
            logger.exception(
                "Skipping malformed cron job %r during due scan",
                job.get("name") or job.get("id") or "?",
            )
            continue

    if needs_save:
        save_jobs(raw_jobs)

    return due


_CRON_OUTPUT_DEFAULT_KEEP = 50


def _cron_output_keep() -> int:
    """Resolve the per-job output retention cap; non-positive disables it."""
    try:
        from fan_cli.config import load_config

        config = load_config() or {}
        cron_config = config.get("cron", {}) if isinstance(config, dict) else {}
        return int(cron_config.get("output_retention", _CRON_OUTPUT_DEFAULT_KEEP))
    except Exception:
        return _CRON_OUTPUT_DEFAULT_KEEP


def _prune_job_output(job_output_dir: Path, keep: int) -> int:
    """Best-effort removal of output files older than the newest *keep*."""
    if keep <= 0:
        return 0
    try:
        files = sorted(
            (path for path in job_output_dir.glob("*.md") if path.is_file()),
            key=lambda path: path.name,
            reverse=True,
        )
    except OSError:
        return 0
    deleted = 0
    for stale in files[keep:]:
        try:
            stale.unlink()
            deleted += 1
        except OSError as exc:
            logger.debug("Failed to prune cron output %s: %s", stale.name, exc)
    return deleted


def save_job_output(job_id: str, output: str):
    """Save job output to file."""
    ensure_dirs()
    job_output_dir = _job_output_dir(job_id)
    job_output_dir.mkdir(parents=True, exist_ok=True)
    _secure_dir(job_output_dir)
    
    timestamp = _fan_now().strftime("%Y-%m-%d_%H-%M-%S")
    output_file = job_output_dir / f"{timestamp}.md"
    
    fd, tmp_path = tempfile.mkstemp(dir=str(job_output_dir), suffix='.tmp', prefix='.output_')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write(output)
            f.flush()
            os.fsync(f.fileno())
        atomic_replace(tmp_path, output_file)
        _secure_file(output_file)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    _prune_job_output(job_output_dir, _cron_output_keep())
    
    return output_file


# =============================================================================
# Skill reference rewriting (curator integration)
# =============================================================================

def rewrite_skill_refs(
    consolidated: Optional[Dict[str, str]] = None,
    pruned: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Rewrite cron job skill references after a curator consolidation pass.

    When the curator consolidates a skill X into umbrella Y (or archives X
    as pruned), any cron job that lists ``X`` in its ``skills`` field will
    fail to load ``X`` at run time — the scheduler logs a warning and
    skips the skill, so the job runs without the instructions it was
    scheduled to follow. See cron/scheduler.py where ``skill_view`` is
    called per skill name.

    This function repairs cron jobs in-place:

    - A skill listed in ``consolidated`` is replaced with its umbrella
      target (the ``into`` value). If the umbrella is already in the
      job's skill list, the stale name is dropped without duplication.
    - A skill listed in ``pruned`` is dropped outright — there is no
      forwarding target.
    - Ordering and other skills in the list are preserved.
    - The legacy ``skill`` field is realigned via ``_apply_skill_fields``.

    Args:
        consolidated: mapping of ``old_skill_name -> umbrella_skill_name``.
        pruned: list of skill names that were archived with no forwarding
            target.

    Returns a report dict::

        {
            "rewrites": [
                {
                    "job_id": ...,
                    "job_name": ...,
                    "before": [...],
                    "after": [...],
                    "mapped": {"old": "new", ...},
                    "dropped": ["old", ...],
                },
                ...
            ],
            "jobs_updated": N,
            "jobs_scanned": M,
        }

    Best-effort: exceptions from loading/saving propagate to the caller so
    tests can assert behaviour; the curator invocation site wraps this
    call in a try/except so a failure here never breaks the curator.
    """
    consolidated = dict(consolidated or {})
    pruned_set = set(pruned or [])
    # A skill listed in both wins as "consolidated" — it has a target,
    # which is the more useful of the two outcomes.
    pruned_set -= set(consolidated.keys())

    if not consolidated and not pruned_set:
        return {"rewrites": [], "jobs_updated": 0, "jobs_scanned": 0}

    with _jobs_lock():
        jobs = load_jobs()
        rewrites: List[Dict[str, Any]] = []
        changed = False

        for job in jobs:
            skills_before = _normalize_skill_list(job.get("skill"), job.get("skills"))
            if not skills_before:
                continue

            mapped: Dict[str, str] = {}
            dropped: List[str] = []
            new_skills: List[str] = []

            for name in skills_before:
                if name in consolidated:
                    target = consolidated[name]
                    mapped[name] = target
                    if target and target not in new_skills:
                        new_skills.append(target)
                elif name in pruned_set:
                    dropped.append(name)
                elif name not in new_skills:
                    new_skills.append(name)

            if not mapped and not dropped:
                continue

            job["skills"] = new_skills
            job["skill"] = new_skills[0] if new_skills else None
            changed = True

            rewrites.append({
                "job_id": job.get("id"),
                "job_name": job.get("name") or job.get("id"),
                "before": list(skills_before),
                "after": list(new_skills),
                "mapped": mapped,
                "dropped": dropped,
            })

        if changed:
            save_jobs(jobs)
            logger.info(
                "Curator rewrote skill references in %d cron job(s)", len(rewrites)
            )

        return {
            "rewrites": rewrites,
            "jobs_updated": len(rewrites),
            "jobs_scanned": len(jobs),
        }
