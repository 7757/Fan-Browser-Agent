"""
Cron job scheduler - executes due jobs.

Provides tick() which checks for due jobs and runs them. The desktop backend
calls this periodically from a background thread.

Uses a file-based lock (~/.fan/cron/.tick.lock) so only one tick
runs at a time if multiple processes overlap.
"""

import atexit
import concurrent.futures
import contextvars
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time

# fcntl is Unix-only; on Windows use msvcrt for file locking
try:
    import fcntl
except ImportError:
    fcntl = None
    try:
        import msvcrt
    except ImportError:
        msvcrt = None
from pathlib import Path
from typing import List, Optional

# Add parent directory to path for imports BEFORE repo-level imports.
# Without this, standalone invocations (e.g. after `fan update` reloads
# the module) fail with ModuleNotFoundError for fan_time et al.
sys.path.insert(0, str(Path(__file__).parent.parent))

from fan_constants import get_fan_home
from fan_cli._subprocess_compat import windows_hide_flags
from fan_cli.config import load_config, _expand_env_vars
from fan_cli.fallback_config import get_fallback_chain
from fan_time import now as _fan_now

logger = logging.getLogger(__name__)


class CronPromptInjectionBlocked(Exception):
    """Raised by _build_job_prompt when the fully-assembled prompt trips the
    injection scanner. Caught in run_job so the operator sees a clean
    clear "job blocked" result instead of the scheduler crashing.

    Assembled-prompt scanning (including loaded skill content) plugs the
    gap from #3968: create-time scanning only covers the user-supplied
    prompt field; skill content loaded at runtime was never scanned, so a
    malicious skill could carry an injection payload that reached the
    non-interactive (auto-approve) cron agent.
    """


def _resolve_cron_disabled_toolsets(cfg: dict) -> list[str]:
    """Toolsets a cron-spawned agent must never receive.

    Protected interactive toolsets are always disabled in cron context:
      - ``cronjob`` — would let a cron-spawned agent schedule more cron jobs
      - ``collect`` — interactive, blocks waiting for user input

    User-level ``agent.disabled_toolsets`` from config.yaml is layered on top
    so per-job ``enabled_toolsets`` cannot bypass policy that applies to
    ordinary agent runs (#25752 — LLM-supplied enabled_toolsets was widening
    past config.yaml's denylist).
    """
    disabled = ["cronjob", "collect"]
    agent_cfg = (cfg or {}).get("agent") or {}
    user_disabled = agent_cfg.get("disabled_toolsets") or []
    for name in user_disabled:
        name = str(name).strip()
        if name and name not in disabled:
            disabled.append(name)
    return disabled


def _merge_mcp_into_per_job_toolsets(per_job: list[str], cfg: dict) -> list[str]:
    """Preserve global MCP availability under a per-job native allowlist."""
    result = [name for name in per_job if name != "no_mcp"]
    if "no_mcp" in per_job:
        return result

    from fan_cli.tools_config import enabled_mcp_server_names

    enabled_mcp = enabled_mcp_server_names(cfg or {})
    if set(result) & enabled_mcp:
        return result
    for name in sorted(enabled_mcp):
        if name not in result:
            result.append(name)
    return result


def _resolve_cron_enabled_toolsets(job: dict, cfg: dict) -> list[str] | None:
    """Resolve the toolset list for a cron job.

    Precedence:
    1. Per-job ``enabled_toolsets`` (set via ``cronjob`` tool on create/update).
       Keeps the agent's job-scoped toolset override intact — #6130.
    2. Per-runtime ``fan tools`` config for the ``cron`` runtime.
       Uses ``_get_platform_tools(cfg, platform_key)``
       so users can gate cron toolsets globally without recreating every job.
    3. ``None`` on any lookup failure — AIAgent loads the full default set
       (legacy behavior before this change, preserved as the safety net).

    _DEFAULT_OFF_TOOLSETS are removed by
    ``_get_platform_tools`` for unconfigured runtimes, so fresh installs
    get cron WITHOUT ``moa`` by default (issue reported by Norbert —
    surprise $4.63 run).
    """
    per_job = job.get("enabled_toolsets")
    if per_job:
        return _merge_mcp_into_per_job_toolsets(list(per_job), cfg or {})
    try:
        from fan_cli.tools_config import _get_platform_tools  # lazy: avoid heavy import at cron module load
        return sorted(_get_platform_tools(cfg or {}, "cron"))
    except Exception as exc:
        logger.warning(
            "Cron toolset resolution failed, falling back to full default toolset: %s",
            exc,
        )
        return None

from cron.jobs import (
    RUN_CLAIM_HEARTBEAT_SECONDS,
    claim_job_for_fire,
    get_due_jobs,
    job_run_claim_is_current,
    mark_job_run,
    record_ticker_heartbeat,
    release_job_run_claim,
    renew_job_run_claim,
    save_job_output,
)

# Sentinel stored when a cron agent has nothing new to report.
SILENT_MARKER = "[SILENT]"

# ---------------------------------------------------------------------------
# Persistent thread pool for parallel cron jobs.
# The tick function submits jobs here and returns immediately so the ticker
# thread is never blocked by long-running jobs (e.g. the fixer running 15+ min).
# ---------------------------------------------------------------------------
_parallel_pool: Optional[concurrent.futures.ThreadPoolExecutor] = None
_parallel_pool_max_workers: Optional[int] = None
_running_job_ids: set = set()
_running_lock = threading.Lock()

# Sequential (env/context-mutating) cron jobs — workdir jobs that touch
# process-global runtime state — must run one at a time, but must NOT block the
# ticker thread.  A persistent single-thread executor preserves ordering across
# ticks while keeping dispatch fire-and-forget, the same as the parallel pool.
_sequential_pool: Optional[concurrent.futures.ThreadPoolExecutor] = None


class _ReadWriteLock:
    """Writer-preferring lock for the process-global ``TERMINAL_CWD``.

    A workdir cron job mutates ``os.environ[\"TERMINAL_CWD\"]`` for its whole
    agent run, so it needs exclusive access.  Jobs without a workdir do not
    mutate that value, but their tools still read it; they may run together,
    but never alongside a writer.  This prevents a parallel job from picking
    up another job's workdir.
    """

    def __init__(self) -> None:
        self._cond = threading.Condition(threading.Lock())
        self._readers = 0
        self._writer_active = False
        self._writers_waiting = 0

    def acquire_read(self) -> None:
        with self._cond:
            while self._writer_active or self._writers_waiting > 0:
                self._cond.wait()
            self._readers += 1

    def release_read(self) -> None:
        with self._cond:
            self._readers -= 1
            if self._readers == 0:
                self._cond.notify_all()

    def acquire_write(self) -> None:
        with self._cond:
            self._writers_waiting += 1
            try:
                while self._writer_active or self._readers > 0:
                    self._cond.wait()
            finally:
                self._writers_waiting -= 1
            self._writer_active = True

    def release_write(self) -> None:
        with self._cond:
            self._writer_active = False
            self._cond.notify_all()


# Workdir jobs write the process-global value while all other jobs read it.
_terminal_cwd_lock = _ReadWriteLock()


def _claim_token_for_job(job: dict) -> str:
    claim = job.get("run_claim")
    if not isinstance(claim, dict):
        return ""
    return str(claim.get("token") or "").strip()


def _start_claim_heartbeat(job: dict) -> tuple[threading.Event, threading.Thread]:
    """Renew a claimed fire while it waits in a pool or executes.

    Starting before ``pool.submit`` matters for sequential workdir jobs: a
    valid claim must not expire merely because an earlier long job occupies
    the single worker.
    """
    job_id = str(job.get("id") or "")
    claim_token = _claim_token_for_job(job)
    stop_event = threading.Event()

    def _heartbeat() -> None:
        while not stop_event.wait(RUN_CLAIM_HEARTBEAT_SECONDS):
            try:
                if not renew_job_run_claim(job_id, claim_token):
                    logger.warning(
                        "Cron run claim for job '%s' is no longer owned; "
                        "stopping heartbeat",
                        job.get("name", job_id),
                    )
                    return
            except Exception:
                # A transient jobs-file failure must not terminate the work.
                # The long lease gives later heartbeats time to recover; if the
                # process truly dies, another scheduler can reclaim after it.
                logger.exception(
                    "Failed to renew Cron run claim for job '%s'",
                    job.get("name", job_id),
                )

    thread = threading.Thread(
        target=_heartbeat,
        name=f"cron-claim-{job_id[:12]}",
        daemon=True,
    )
    thread.start()
    return stop_event, thread


def _stop_claim_heartbeat(
    stop_event: threading.Event,
    thread: threading.Thread,
) -> None:
    stop_event.set()
    if thread is not threading.current_thread():
        thread.join(timeout=1.0)


def _get_parallel_pool(max_workers: Optional[int]) -> concurrent.futures.ThreadPoolExecutor:
    """Return (or create) the persistent parallel pool."""
    global _parallel_pool, _parallel_pool_max_workers
    if _parallel_pool is None or _parallel_pool_max_workers != max_workers:
        if _parallel_pool is not None:
            _parallel_pool.shutdown(wait=False, cancel_futures=False)
        _parallel_pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=max_workers,
            thread_name_prefix="cron-parallel",
        )
        _parallel_pool_max_workers = max_workers
    return _parallel_pool


def _get_sequential_pool() -> concurrent.futures.ThreadPoolExecutor:
    """Return (or create) the persistent single-thread sequential pool.

    A single worker guarantees env/context-mutating jobs never overlap, even
    across ticks: a job queued by a newer tick waits for the previous tick's
    sequential jobs to finish rather than corrupting their os.environ state.
    """
    global _sequential_pool
    if _sequential_pool is None:
        _sequential_pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="cron-seq",
        )
    return _sequential_pool


def _shutdown_parallel_pool() -> None:
    """Shut down the persistent pools on process exit."""
    global _parallel_pool, _parallel_pool_max_workers, _sequential_pool
    if _parallel_pool is not None:
        _parallel_pool.shutdown(wait=True, cancel_futures=False)
        _parallel_pool = None
        _parallel_pool_max_workers = None
    if _sequential_pool is not None:
        _sequential_pool.shutdown(wait=True, cancel_futures=False)
        _sequential_pool = None


atexit.register(_shutdown_parallel_pool)


# Backward-compatible module override used by tests and emergency monkeypatches.
_fan_home: Path | None = None


def _get_fan_home() -> Path:
    """Resolve Fan home dynamically while preserving test monkeypatch hooks."""
    return _fan_home or get_fan_home()


def _get_lock_paths() -> tuple[Path, Path]:
    """Resolve cron lock paths at call time so env changes are honored."""
    fan_home = _get_fan_home()
    lock_dir = fan_home / "cron"
    return lock_dir, lock_dir / ".tick.lock"


# Data-collection scripts can legitimately prepare a report, wait for a local
# service, or fetch several sources. Keep the default aligned with the cron
# job lifetime rather than terminating useful pre-run work after two minutes.
_DEFAULT_SCRIPT_TIMEOUT = 3600  # seconds
# Backward-compatible module override used by tests and emergency monkeypatches.
_SCRIPT_TIMEOUT = _DEFAULT_SCRIPT_TIMEOUT
_DEFAULT_SESSION_DB_TIMEOUT = 10.0


def _get_script_timeout() -> int:
    """Resolve cron pre-run script timeout from module/env/config with a safe default."""
    if _SCRIPT_TIMEOUT != _DEFAULT_SCRIPT_TIMEOUT:
        try:
            timeout = int(float(_SCRIPT_TIMEOUT))
            if timeout > 0:
                return timeout
        except Exception:
            logger.warning("Invalid patched _SCRIPT_TIMEOUT=%r; using env/config/default", _SCRIPT_TIMEOUT)

    env_value = os.getenv("FAN_CRON_SCRIPT_TIMEOUT", "").strip()
    if env_value:
        try:
            timeout = int(float(env_value))
            if timeout > 0:
                return timeout
        except Exception:
            logger.warning("Invalid FAN_CRON_SCRIPT_TIMEOUT=%r; using config/default", env_value)

    try:
        cfg = load_config() or {}
        cron_cfg = cfg.get("cron", {}) if isinstance(cfg, dict) else {}
        configured = cron_cfg.get("script_timeout_seconds")
        if configured is not None:
            timeout = int(float(configured))
            if timeout > 0:
                return timeout
    except Exception as exc:
        logger.debug("Failed to load cron script timeout from config: %s", exc)

    return _DEFAULT_SCRIPT_TIMEOUT


def _get_session_db_timeout() -> float:
    """Resolve the bounded SessionDB initialization timeout from config."""
    try:
        cfg = load_config() or {}
        cron_cfg = cfg.get("cron", {}) if isinstance(cfg, dict) else {}
        configured = cron_cfg.get("session_db_timeout_seconds")
        if configured is not None:
            timeout = float(configured)
            if timeout > 0:
                return timeout
            logger.warning(
                "Invalid cron.session_db_timeout_seconds=%r; using default %.0fs",
                configured,
                _DEFAULT_SESSION_DB_TIMEOUT,
            )
    except (TypeError, ValueError) as exc:
        logger.warning(
            "Invalid cron.session_db_timeout_seconds; using default %.0fs: %s",
            _DEFAULT_SESSION_DB_TIMEOUT,
            exc,
        )
    except Exception as exc:
        logger.debug("Failed to load cron SessionDB timeout: %s", exc)
    return _DEFAULT_SESSION_DB_TIMEOUT


def _init_session_db_bounded(job_id: str):
    """Construct SessionDB within a deadline, returning None on failure."""
    timeout = _get_session_db_timeout()
    pool = None
    try:
        from fan_state import SessionDB
        from tools.daemon_pool import DaemonThreadPoolExecutor

        context = contextvars.copy_context()
        pool = DaemonThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="cron-session-db",
        )
        future = pool.submit(context.run, SessionDB)
        return future.result(timeout=timeout)
    except concurrent.futures.TimeoutError:
        logger.error(
            "Job '%s': SessionDB init did not return within %.1fs; "
            "continuing without session persistence",
            job_id,
            timeout,
        )
        return None
    except Exception as exc:
        logger.debug("Job '%s': SQLite session store not available: %s", job_id, exc)
        return None
    finally:
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)


def _run_job_script(script_path: str) -> tuple[bool, str]:
    """Execute a cron job's data-collection script and capture its output.

    Scripts must reside within FAN_HOME/scripts/.  Both relative and
    absolute paths are resolved and validated against this directory to
    prevent arbitrary script execution via path traversal or absolute
    path injection.

    Supported interpreters (chosen by file extension):

    * ``.sh`` / ``.bash`` — run with ``/bin/bash``
    * anything else — run with the current Python interpreter
      (``sys.executable``), preserving the original behaviour for
      Python-based pre-check and data-collection scripts.

    Shell support lets ``no_agent=True`` jobs ship classic bash watchdogs
    (the `memory-watchdog.sh` pattern) without wrapping them in Python.

    Args:
        script_path: Path to the script.  Relative paths are resolved
            against FAN_HOME/scripts/.  Absolute and ~-prefixed paths
            are also validated to ensure they stay within the scripts dir.

    Returns:
        (success, output) — on failure *output* contains the error message so the
        LLM can report the problem to the user.
    """
    scripts_dir = _get_fan_home() / "scripts"
    scripts_dir.mkdir(parents=True, exist_ok=True)
    scripts_dir_resolved = scripts_dir.resolve()

    raw = Path(script_path).expanduser()
    if raw.is_absolute():
        path = raw.resolve()
    else:
        path = (scripts_dir / raw).resolve()

    # Guard against path traversal, absolute path injection, and symlink
    # escape — scripts MUST reside within FAN_HOME/scripts/.
    try:
        path.relative_to(scripts_dir_resolved)
    except ValueError:
        return False, (
            f"Blocked: script path resolves outside the scripts directory "
            f"({scripts_dir_resolved}): {script_path!r}"
        )

    if not path.exists():
        return False, f"Script not found: {path}"
    if not path.is_file():
        return False, f"Script path is not a file: {path}"

    script_timeout = _get_script_timeout()

    # Pick an interpreter by extension.  Bash for .sh/.bash, Python for
    # everything else.  We deliberately do NOT honour the file's own
    # shebang: the scripts dir is trusted, but keeping the interpreter
    # choice explicit here keeps the allowed surface small and auditable.
    suffix = path.suffix.lower()
    if suffix in {".sh", ".bash"}:
        # Resolve bash via the shared environment resolver so Windows
        # (Git Bash) and Linux/macOS all work. The resolver also refuses
        # Windows' System32 WSL relay shim, which a bare which("bash")
        # happily returns even though it can't run anything when the
        # default WSL distro is docker-desktop. Fall back to a clear
        # error rather than a confusing "[WinError 2]" traceback.
        try:
            from tools.environments.local import _find_bash
            _bash = _find_bash()
        except Exception:
            _bash = None
        if _bash is None:
            return False, (
                f"Cannot run .sh/.bash script {path.name!r}: bash not found on PATH. "
                "On Windows, install Git for Windows (which ships Git Bash) "
                "or rewrite the script as Python (.py)."
            )
        argv = [_bash, str(path)]
    else:
        argv = [sys.executable, str(path)]

    # Cron scripts are user/Agent-controlled child processes. They must not
    # inherit the desktop backend's provider credentials or loopback browser
    # capabilities. Use the same centralized sanitizer as terminal/MCP paths;
    # it also marks the child as Agent-owned so `fan config set` cannot be used
    # from a persistent cron script to rewrite local execution authority.
    from tools.environments.local import _sanitize_subprocess_env

    run_env = _sanitize_subprocess_env(os.environ.copy())
    run_env["FAN_HOME"] = str(_get_fan_home())
    try:
        from fan_constants import get_subprocess_home

        profile_home = get_subprocess_home()
        if profile_home:
            run_env["HOME"] = profile_home
    except Exception:
        pass

    try:
        popen_kwargs = {"creationflags": windows_hide_flags()} if sys.platform == "win32" else {}
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=script_timeout,
            cwd=str(path.parent),
            env=run_env,
            **popen_kwargs,
        )
        stdout = (result.stdout or "").strip()
        stderr = (result.stderr or "").strip()

        # Redact secrets from both stdout and stderr before any return path.
        try:
            from agent.redact import redact_sensitive_text
            stdout = redact_sensitive_text(stdout)
            stderr = redact_sensitive_text(stderr)
        except Exception as exc:
            logger.warning("Failed to redact sensitive text from output: %s", exc)
            stdout = "[REDACTED - redaction failed]"
            stderr = "[REDACTED - redaction failed]"

        if result.returncode != 0:
            parts = [f"Script exited with code {result.returncode}"]
            if stderr:
                parts.append(f"stderr:\n{stderr}")
            if stdout:
                parts.append(f"stdout:\n{stdout}")
            return False, "\n".join(parts)

        return True, stdout

    except subprocess.TimeoutExpired:
        return False, f"Script timed out after {script_timeout}s: {path}"
    except Exception as exc:
        return False, f"Script execution failed: {exc}"


def _parse_wake_gate(script_output: str) -> bool:
    """Parse the last non-empty stdout line of a cron job's pre-check script
    as a wake gate.

    The convention (ported from nanoclaw #1232): if the last stdout line is
    JSON like ``{"wakeAgent": false}``, the agent is skipped entirely — no
    LLM run and no report. Any other output (non-JSON, missing flag, gate
    absent, or ``wakeAgent: true``) means wake the agent normally.

    Returns True if the agent should wake, False to skip.
    """
    if not script_output:
        return True
    stripped_lines = [line for line in script_output.splitlines() if line.strip()]
    if not stripped_lines:
        return True
    last_line = stripped_lines[-1].strip()
    try:
        gate = json.loads(last_line)
    except (json.JSONDecodeError, ValueError):
        return True
    if not isinstance(gate, dict):
        return True
    return gate.get("wakeAgent", True) is not False


def _build_job_prompt(job: dict, prerun_script: Optional[tuple] = None) -> str:
    """Build the effective prompt for a cron job, optionally loading one or more skills first.

    Args:
        job: The cron job dict.
        prerun_script: Optional ``(success, stdout)`` from a script that has
            already been executed by the caller (e.g. for a wake-gate check).
            When provided, the script is not re-executed and the cached
            result is used for prompt injection. When omitted, the script
            (if any) runs inline as before.
    """
    prompt = str(job.get("prompt") or "")
    skills = job.get("skills")

    # Run data-collection script if configured, inject output as context.
    script_path = job.get("script")
    if script_path:
        if prerun_script is not None:
            success, script_output = prerun_script
        else:
            success, script_output = _run_job_script(script_path)
        if success:
            if script_output:
                prompt = (
                    "## Script Output\n"
                    "The following data was collected by a pre-run script. "
                    "Use it as context for your analysis.\n\n"
                    f"```\n{script_output}\n```\n\n"
                    f"{prompt}"
                )
            else:
                # Script produced no output — nothing to report, skip AI call.
                return None
        else:
            prompt = (
                "## Script Error\n"
                "The data-collection script failed. Report this to the user.\n\n"
                f"```\n{script_output}\n```\n\n"
                f"{prompt}"
            )

    # Inject output from referenced cron jobs as context.
    context_from = job.get("context_from")
    if context_from:
        from cron.jobs import OUTPUT_DIR
        if isinstance(context_from, str):
            context_from = [context_from]
        for source_job_id in context_from:
            # Guard against path traversal — valid job IDs are 12-char hex strings
            if not source_job_id or not all(c in "0123456789abcdef" for c in source_job_id):
                logger.warning(
                    "context_from: skipping invalid job_id %r for job_id=%r name=%r",
                    source_job_id,
                    job.get("id"),
                    job.get("name"),
                )
                continue
            try:
                job_output_dir = OUTPUT_DIR / source_job_id
                if not job_output_dir.exists():
                    continue  # silent skip — no output yet
                output_files = sorted(
                    job_output_dir.glob("*.md"),
                    key=lambda f: f.stat().st_mtime,
                    reverse=True,
                )
                if not output_files:
                    continue  # silent skip — no output yet
                latest_output = output_files[0].read_text(encoding="utf-8").strip()
                # Truncate to 8K characters to avoid prompt bloat
                _MAX_CONTEXT_CHARS = 8000
                if len(latest_output) > _MAX_CONTEXT_CHARS:
                    latest_output = latest_output[:_MAX_CONTEXT_CHARS] + "\n\n[... output truncated ...]"
                if latest_output:
                    prompt = (
                        f"## Output from job '{source_job_id}'\n"
                        "The following is the most recent output from a preceding "
                        "cron job. Use it as context for your analysis.\n\n"
                        f"```\n{latest_output}\n```\n\n"
                        f"{prompt}"
                    )
                else:
                    continue  # silent skip — empty output
            except (OSError, PermissionError) as e:
                logger.warning("context_from: failed to read output for job %r: %s", source_job_id, e)
                # silent skip — do not pollute the prompt with error messages

    # Always prepend cron execution guidance. Results are persisted locally.
    cron_hint = (
        "[IMPORTANT: You are running as a scheduled cron job. "
        "OUTPUT: Your final response will be saved to the local Cron history. "
        "SILENT: If there is genuinely nothing new to record, respond "
        "with exactly \"[SILENT]\" (nothing else). "
        "Never combine [SILENT] with content — either report your "
        "findings normally, or say [SILENT] and nothing more.]\n\n"
    )
    prompt = cron_hint + prompt
    if skills is None:
        legacy = job.get("skill")
        skills = [legacy] if legacy else []
    elif isinstance(skills, str):
        skills = [skills]

    skill_names = [str(name).strip() for name in skills if str(name).strip()]
    if not skill_names:
        return _scan_assembled_cron_prompt(prompt, job, has_skills=False)

    from tools.skills_tool import skill_view
    from tools.skill_usage import bump_use
    from agent.skill_bundles import build_bundle_invocation_message, resolve_bundle_command_key

    parts = []
    skipped: list[str] = []
    for skill_name in skill_names:
        # Cron jobs historically accepted only skill names here, but the CLI
        # slash-command path lets bundles shadow skills with the same slug. Mirror
        # that behavior so `skills: ["my-bundle"]` expands bundle members instead
        # of being treated as a missing skill.
        bundle_key = resolve_bundle_command_key(skill_name.lstrip("/"))
        if bundle_key:
            bundle_payload = build_bundle_invocation_message(
                bundle_key,
                user_instruction="",
                task_id=str(job.get("id") or "") or None,
            )
            if bundle_payload:
                bundle_message, _loaded_bundle_skills, _missing_bundle_skills = bundle_payload
                if parts:
                    parts.append("")
                parts.append(bundle_message)
                continue
            logger.warning(
                "Cron job '%s': bundle '%s' could not load any skills, skipping",
                job.get("name", job.get("id")),
                skill_name,
            )
            skipped.append(skill_name)
            continue

        try:
            loaded = json.loads(skill_view(skill_name))
        except (json.JSONDecodeError, TypeError):
            logger.warning("Cron job '%s': skill '%s' returned invalid JSON, skipping", job.get("name", job.get("id")), skill_name)
            skipped.append(skill_name)
            continue
        if not loaded.get("success"):
            error = loaded.get("error") or f"Failed to load skill '{skill_name}'"
            logger.warning("Cron job '%s': skill not found, skipping — %s", job.get("name", job.get("id")), error)
            skipped.append(skill_name)
            continue

        # Bump usage so the curator sees this skill as actively used.
        try:
            bump_use(skill_name)
        except Exception:
            logger.debug("Cron job: failed to bump skill usage for '%s'", skill_name, exc_info=True)

        content = str(loaded.get("content") or "").strip()
        if parts:
            parts.append("")
        parts.extend(
            [
                f'[IMPORTANT: The user has invoked the "{skill_name}" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]',
                "",
                content,
            ]
        )

    if skipped:
        notice = (
            f"[IMPORTANT: The following skill(s) were listed for this job but could not be found "
            f"and were skipped: {', '.join(skipped)}. "
            f"Start your response with a brief notice so the user is aware, e.g.: "
            f"'⚠️ Skill(s) not found and skipped: {', '.join(skipped)}']"
        )
        parts.insert(0, notice)

    if prompt:
        parts.extend(["", f"The user has provided the following instruction alongside the skill invocation: {prompt}"])
    return _scan_assembled_cron_prompt("\n".join(parts), job, has_skills=True)


def _scan_assembled_cron_prompt(assembled: str, job: dict, *, has_skills: bool = False) -> str:
    """Scan the fully-assembled cron prompt for injection patterns. Raises
    ``CronPromptInjectionBlocked`` when a match fires so ``run_job`` can
    surface a clear refusal to the operator.

    Plugs the #3968 gap: ``_scan_cron_prompt`` runs on the user-supplied
    prompt at create/update, but skill content is loaded from disk at
    runtime and was never scanned. Since cron runs non-interactively
    (auto-approves tool calls), a malicious skill carrying an injection
    payload bypassed every gate.

    Two pattern tiers:

    - When ``has_skills=False`` (no skills attached) the assembled prompt
      is essentially the user prompt + the cron hint, so the STRICT
      ``_scan_cron_prompt`` patterns apply.
    - When ``has_skills=True`` the assembled prompt includes loaded skill
      markdown — often security docs / runbooks that *describe* attack
      commands in prose. The LOOSER ``_scan_cron_skill_assembled``
      pattern set is used: only unambiguous prompt-injection directives
      block; command-shape patterns are dropped and invisible unicode is
      sanitized (stripped + logged) rather than blocked, to avoid
      false-positives that permanently kill a job. Skill bodies are
      vetted at install time by ``skills_guard.py``.
    """
    from tools.cronjob_tools import _scan_cron_prompt, _scan_cron_skill_assembled

    if has_skills:
        # Skill content is install-time vetted by skills_guard.py. Invisible
        # unicode is sanitized (not blocked) so a stray zero-width space in a
        # skill code example can't permanently kill the job; the cleaned
        # prompt is what actually runs.
        cleaned, scan_error = _scan_cron_skill_assembled(assembled)
        assembled = cleaned
    else:
        scan_error = _scan_cron_prompt(assembled)
    if scan_error:
        job_label = job.get("name") or job.get("id") or "<unknown>"
        logger.warning(
            "Cron job '%s': assembled prompt blocked by injection scanner — %s",
            job_label,
            scan_error,
        )
        raise CronPromptInjectionBlocked(scan_error)
    return assembled


def _guard_job_credential_exfil(job: dict) -> None:
    """Refuse an unsafe stored provider/base_url pair before resolution.

    Cron's model-facing create/update path validates this combination, but
    persisted legacy jobs (or direct jobs-store edits) still arrive here.  A
    named provider's stored credential must never be paired with an arbitrary
    job-supplied endpoint.
    """
    try:
        from tools.cronjob_tools import _validate_cron_base_url

        err = _validate_cron_base_url(job.get("provider"), job.get("base_url"))
    except Exception as exc:
        # This is the last guard before provider resolution.  A job without an
        # override cannot use this path to redirect a stored credential, while
        # a job with one must not proceed unless validation actually succeeds.
        err = (
            f"could not validate provider/base_url pair "
            f"({exc.__class__.__name__}: {exc}); refusing to run a job with "
            "an unverified base_url override"
            if job.get("base_url")
            else None
        )
    if err:
        job_id = job.get("id")
        logger.error(
            "Job '%s': refusing to run — unsafe provider/base_url pair could "
            "exfiltrate a stored credential: %s",
            job_id,
            err,
        )
        raise RuntimeError(f"Cron job '{job_id}' blocked for safety: {err}")


def run_job(job: dict) -> tuple[bool, str, str, Optional[str]]:
    """Execute a single cron job."""
    return _run_job_impl(job)


def _run_job_impl(job: dict) -> tuple[bool, str, str, Optional[str]]:
    """
    Execute a single cron job.
    
    Returns:
        Tuple of (success, full_output_doc, final_response, error_message)
    """
    job_id = job["id"]
    job_name = str(job.get("name") or job.get("prompt") or job_id or "cron job")

    # ---------------------------------------------------------------
    # no_agent short-circuit — the script IS the job, no LLM involvement.
    # ---------------------------------------------------------------
    # This mirrors the classic "run a bash script on a timer" watchdog
    # pattern. The agent path is skipped
    # entirely: no AIAgent, no prompt, no tool loop, no token spend.
    #
    # We check this BEFORE importing run_agent / constructing SessionDB so
    # a pure-script tick never pays for the agent machinery it isn't going
    # to use. Keep this block self-contained.
    #
    # Semantics:
    #   - script stdout (trimmed) → saved verbatim as the final result
    #   - empty stdout            → silent run (success=True)
    #   - non-zero exit / timeout → saved as an error result, success=False
    #   - wakeAgent=false gate    → treated like empty stdout (silent), since
    #                               the whole point of no_agent is that there
    #                               is no agent to wake
    if job.get("no_agent"):
        script_path = job.get("script")
        if not script_path:
            err = "no_agent=True but no script is set for this job"
            logger.error("Job '%s': %s", job_id, err)
            return False, "", "", err

        # Apply workdir if configured — lets scripts use predictable relative
        # paths. For no_agent jobs this is just the subprocess cwd (not an
        # agent TERMINAL_CWD bridge).
        _job_workdir = (job.get("workdir") or "").strip() or None
        _prior_cwd = None
        if _job_workdir and Path(_job_workdir).is_dir():
            _prior_cwd = os.getcwd()
            try:
                os.chdir(_job_workdir)
            except OSError:
                _prior_cwd = None

        try:
            ok, output = _run_job_script(script_path)
        finally:
            if _prior_cwd is not None:
                try:
                    os.chdir(_prior_cwd)
                except OSError:
                    pass

        now_iso = _fan_now().strftime("%Y-%m-%d %H:%M:%S")

        if not ok:
            # Script crashed / timed out / exited non-zero. Save the error so
            # the user knows the watchdog itself broke — silent
            # failure for an alerting job is the worst-case outcome.
            alert = (
                f"⚠ Cron watchdog '{job_name}' script failed\n\n"
                f"{output}\n\n"
                f"Time: {now_iso}"
            )
            doc = (
                f"# Cron Job: {job_name}\n\n"
                f"**Job ID:** {job_id}\n"
                f"**Run Time:** {now_iso}\n"
                f"**Mode:** no_agent (script)\n"
                f"**Status:** script failed\n\n"
                f"{output}\n"
            )
            return False, doc, alert, output

        # Honour the wakeAgent gate as a silent signal — `wakeAgent: false`
        # means "nothing to report this tick", same as empty stdout.
        if not _parse_wake_gate(output):
            logger.info(
                "Job '%s' (no_agent): wakeAgent=false gate — silent run", job_id
            )
            silent_doc = (
                f"# Cron Job: {job_name}\n\n"
                f"**Job ID:** {job_id}\n"
                f"**Run Time:** {now_iso}\n"
                f"**Mode:** no_agent (script)\n"
                f"**Status:** silent (wakeAgent=false)\n"
            )
            return True, silent_doc, SILENT_MARKER, None

        if not output.strip():
            logger.info("Job '%s' (no_agent): empty stdout — silent run", job_id)
            silent_doc = (
                f"# Cron Job: {job_name}\n\n"
                f"**Job ID:** {job_id}\n"
                f"**Run Time:** {now_iso}\n"
                f"**Mode:** no_agent (script)\n"
                f"**Status:** silent (empty output)\n"
            )
            return True, silent_doc, SILENT_MARKER, None

        doc = (
            f"# Cron Job: {job_name}\n\n"
            f"**Job ID:** {job_id}\n"
            f"**Run Time:** {now_iso}\n"
            f"**Mode:** no_agent (script)\n\n"
            f"---\n\n"
            f"{output}\n"
        )
        return True, doc, output, None

    # ---------------------------------------------------------------
    # Default (LLM) path — import and construct the agent machinery now
    # that we know we actually need it. Doing these imports here instead of
    # at module top keeps no_agent ticks from paying for AIAgent / SessionDB
    # construction costs.
    # ---------------------------------------------------------------
    from run_agent import AIAgent

    # Initialize SQLite session store so cron job messages are persisted
    # and discoverable via session_search.
    _session_db = _init_session_db_bounded(str(job.get("id", "?")))

    # Wake-gate: if this job has a pre-check script, run it BEFORE building
    # the prompt so a ``{"wakeAgent": false}`` response can short-circuit
    # the whole agent run. We pass the result into _build_job_prompt so
    # the script is only executed once.
    prerun_script = None
    script_path = job.get("script")
    if script_path:
        prerun_script = _run_job_script(script_path)
        _ran_ok, _script_output = prerun_script
        if _ran_ok and not _parse_wake_gate(_script_output):
            logger.info(
                "Job '%s' (ID: %s): wakeAgent=false, skipping agent run",
                job_name, job_id,
            )
            silent_doc = (
                f"# Cron Job: {job_name}\n\n"
                f"**Job ID:** {job_id}\n"
                f"**Run Time:** {_fan_now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
                "Script gate returned `wakeAgent=false` — agent skipped.\n"
            )
            return True, silent_doc, SILENT_MARKER, None

    try:
        prompt = _build_job_prompt(job, prerun_script=prerun_script)
    except CronPromptInjectionBlocked as block_exc:
        # Assembled prompt (user prompt + loaded skill content) tripped the
        # injection scanner. Refuse to run the agent this tick and surface
        # a clear failure to the operator so they see WHY the scheduled job
        # didn't run and can audit the offending skill.
        logger.warning(
            "Job '%s' (ID: %s): blocked by prompt-injection scanner — %s",
            job_name, job_id, block_exc,
        )
        blocked_doc = (
            f"# Cron Job: {job_name}\n\n"
            f"**Job ID:** {job_id}\n"
            f"**Run Time:** {_fan_now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"**Status:** BLOCKED\n\n"
            "The assembled prompt (user prompt + loaded skill content) tripped "
            "the cron injection scanner and the agent was NOT run.\n\n"
            f"**Scanner result:** {block_exc}\n\n"
            "Audit the skill(s) attached to this job for prompt-injection "
            "payloads or invisible-unicode markers. If the skill is legitimate "
            "and the match is a false positive, rephrase the content to avoid "
            "the threat pattern (`tools/cronjob_tools.py::_CRON_THREAT_PATTERNS`)."
        )
        return False, blocked_doc, "", str(block_exc)
    if prompt is None:
        logger.info("Job '%s': script produced no output, skipping AI call.", job_name)
        return True, "", SILENT_MARKER, None
    _cron_session_id = f"cron_{job_id}_{_fan_now().strftime('%Y%m%d_%H%M%S')}"

    logger.info("Running job '%s' (ID: %s)", job_name, job_id)
    logger.info("Prompt: %s", prompt[:100])

    agent = None

    # Mark this as a cron session so the approval system can apply cron_mode.
    # This env var is process-wide and persists for the lifetime of the
    # scheduler process — every job this process runs is a cron job.
    os.environ["FAN_CRON_SESSION"] = "1"

    # Per-job working directory.  When set (and validated at create/update
    # time), we point TERMINAL_CWD at it so:
    #   - build_context_files_prompt() picks up AGENTS.md / CLAUDE.md /
    #     .cursorrules from the job's project dir, AND
    #   - the terminal, file, and code-exec tools run commands from there.
    #
    # ``TERMINAL_CWD`` is process-global. Workdir jobs take an exclusive lock
    # while they set it; workdir-less jobs take a shared lock because their
    # tools can still read it. The sequential pool alone only keeps workdir
    # jobs from overlapping each other, not from leaking into parallel jobs.
    _job_workdir = (job.get("workdir") or "").strip() or None
    if _job_workdir and not Path(_job_workdir).is_dir():
        # Directory was removed between create-time validation and now.  Log
        # and drop back to old behaviour rather than crashing the job.
        logger.warning(
            "Job '%s': configured workdir %r no longer exists — running without it",
            job_id, _job_workdir,
        )
        _job_workdir = None
    # Snapshot before acquisition so the cleanup below has a defined restore
    # target even if a later setup statement raises.
    _prior_terminal_cwd = os.environ.get("TERMINAL_CWD", "_UNSET_")
    _holds_cwd_write = _job_workdir is not None
    if _holds_cwd_write:
        _terminal_cwd_lock.acquire_write()
    else:
        _terminal_cwd_lock.acquire_read()

    try:
        if _job_workdir:
            os.environ["TERMINAL_CWD"] = _job_workdir
            logger.info("Job '%s': using workdir %s", job_id, _job_workdir)

        # Re-read .env and config.yaml fresh every run so provider/key
        # changes take effect without restarting the desktop backend.
        from dotenv import load_dotenv
        try:
            load_dotenv(str(_get_fan_home() / ".env"), override=True, encoding="utf-8")
        except UnicodeDecodeError:
            load_dotenv(str(_get_fan_home() / ".env"), override=True, encoding="latin-1")

        model = job.get("model") or os.getenv("FAN_MODEL") or ""

        # Load the local config for model, reasoning, prefill, toolsets and
        # provider routing.
        _cfg = {}
        try:
            import yaml
            _cfg_path = str(_get_fan_home() / "config.yaml")
            if os.path.exists(_cfg_path):
                with open(_cfg_path, encoding="utf-8") as _f:
                    _cfg = yaml.safe_load(_f) or {}
            _cfg = _expand_env_vars(_cfg)
            _model_cfg = _cfg.get("model") or {}
            if not job.get("model"):
                if isinstance(_model_cfg, str):
                    model = _model_cfg
                elif isinstance(_model_cfg, dict):
                    configured_default = (
                        _model_cfg.get("default") or _model_cfg.get("model")
                    )
                    if configured_default:
                        model = configured_default
        except Exception as e:
            logger.warning("Job '%s': failed to load effective config, using defaults: %s", job_id, e)

        if not (isinstance(model, str) and model.strip()):
            raise RuntimeError(
                f"Cron job '{job_name}' has no model configured "
                f"(job.model={job.get('model')!r}, "
                f"FAN_MODEL={os.getenv('FAN_MODEL', '')!r}, "
                "config.yaml model.default/model missing or empty). "
                f"Update job {job_id} with an explicit model or configure "
                "the application's default model."
            )

        # Apply IPv4 preference if configured.
        try:
            from fan_constants import apply_ipv4_preference
            _net_cfg = _cfg.get("network", {})
            if isinstance(_net_cfg, dict) and _net_cfg.get("force_ipv4"):
                apply_ipv4_preference(force=True)
        except Exception:
            pass

        # Reasoning config from config.yaml
        from fan_constants import parse_reasoning_effort
        effort = str(_cfg.get("agent", {}).get("reasoning_effort", "")).strip()
        reasoning_config = parse_reasoning_effort(effort)

        # Prefill messages from env or config.yaml. The top-level
        # prefill_messages_file key is canonical; agent.prefill_messages_file is
        # retained as a legacy fallback for older CLI/godmode configs.
        prefill_messages = None
        agent_cfg = _cfg.get("agent", {}) if isinstance(_cfg.get("agent", {}), dict) else {}
        prefill_file = (
            os.getenv("FAN_PREFILL_MESSAGES_FILE", "")
            or _cfg.get("prefill_messages_file", "")
            or agent_cfg.get("prefill_messages_file", "")
        )
        if prefill_file:
            pfpath = Path(prefill_file).expanduser()
            if not pfpath.is_absolute():
                pfpath = _get_fan_home() / pfpath
            if pfpath.exists():
                try:
                    with open(pfpath, "r", encoding="utf-8") as _pf:
                        prefill_messages = json.load(_pf)
                    if not isinstance(prefill_messages, list):
                        prefill_messages = None
                except Exception as e:
                    logger.warning("Job '%s': failed to parse prefill messages file '%s': %s", job_id, pfpath, e)
                    prefill_messages = None

        # Max iterations
        max_iterations = _cfg.get("agent", {}).get("max_turns") or _cfg.get("max_turns") or 90

        # Provider routing
        pr = _cfg.get("provider_routing") or {}

        from fan_cli.runtime_provider import (
            resolve_runtime_provider,
            format_runtime_provider_error,
        )
        from fan_cli.auth import AuthError

        # Validate persisted state again at the provider-resolution sink. This
        # protects jobs created before the tool boundary guard or written
        # directly into the jobs store.
        _guard_job_credential_exfil(job)

        try:
            # Do not inject FAN_INFERENCE_PROVIDER here. resolve_runtime_provider()
            # already prefers persisted config over stale shell/env overrides when
            # no explicit provider is requested. Passing the env var here short-
            # circuits that precedence and can resurrect old providers (for
            # example DeepSeek) for cron jobs that do not pin provider/model.
            runtime_kwargs = {
                "requested": job.get("provider"),
            }
            if job.get("base_url"):
                runtime_kwargs["explicit_base_url"] = job.get("base_url")
            runtime = resolve_runtime_provider(**runtime_kwargs)
        except AuthError as auth_exc:
            # Primary provider auth failed — try fallback chain before giving up.
            logger.warning("Job '%s': primary auth failed (%s), trying fallback", job_id, auth_exc)
            fb_list = get_fallback_chain(_cfg)
            runtime = None
            for entry in fb_list:
                if not isinstance(entry, dict):
                    continue
                try:
                    fb_kwargs = {"requested": entry.get("provider")}
                    if entry.get("base_url"):
                        fb_kwargs["explicit_base_url"] = entry["base_url"]
                    if entry.get("api_key"):
                        fb_kwargs["explicit_api_key"] = entry["api_key"]
                    runtime = resolve_runtime_provider(**fb_kwargs)
                    logger.info("Job '%s': fallback resolved to %s", job_id, runtime.get("provider"))
                    break
                except Exception as fb_exc:
                    logger.debug("Job '%s': fallback %s failed: %s", job_id, entry.get("provider"), fb_exc)
            if runtime is None:
                raise RuntimeError(format_runtime_provider_error(auth_exc)) from auth_exc
        except Exception as exc:
            message = format_runtime_provider_error(exc)
            raise RuntimeError(message) from exc

        # Guard unpinned jobs against global inference-config drift. A cron
        # job created before a temporary default/provider switch must not make
        # a paid call on the new route without the owner's explicit choice.
        drift: list[str] = []
        provider_snapshot = str(job.get("provider_snapshot") or "").strip().lower()
        if provider_snapshot and not str(job.get("provider") or "").strip():
            current_provider = str(runtime.get("provider") or "").strip().lower()
            if current_provider and current_provider != provider_snapshot:
                drift.append(
                    f"provider '{provider_snapshot}' -> '{current_provider}'"
                )
        model_snapshot = str(job.get("model_snapshot") or "").strip().lower()
        if model_snapshot and not str(job.get("model") or "").strip():
            current_model = str(model or "").strip().lower()
            if current_model and current_model != model_snapshot:
                drift.append(f"model '{model_snapshot}' -> '{current_model}'")
        if drift:
            changes = "; ".join(drift)
            logger.warning(
                "Job '%s': skipped because global inference config drifted since "
                "creation (%s); pin provider/model to allow the new route",
                job_id,
                changes,
            )
            raise RuntimeError(
                "Skipped to prevent unintended spend: global inference config "
                f"drifted since this job was created ({changes}), and this job "
                "is unpinned. No inference call was made. Pin provider and/or "
                f"model explicitly on cron job {job_id} to proceed."
            )

        fallback_model = get_fallback_chain(_cfg) or None
        credential_pool = None
        runtime_provider = str(runtime.get("provider") or "").strip().lower()
        if runtime_provider:
            try:
                from agent.credential_pool import load_pool
                pool = load_pool(runtime_provider)
                if pool.has_credentials():
                    credential_pool = pool
                    logger.info(
                        "Job '%s': loaded credential pool for provider %s with %d entries",
                        job_id,
                        runtime_provider,
                        len(pool.entries()),
                    )
            except Exception as e:
                logger.debug("Job '%s': failed to load credential pool for %s: %s", job_id, runtime_provider, e)

        # Initialize MCP servers so configured mcp_servers are available to
        # the agent's tool registry before AIAgent is constructed. Without
        # this, cron jobs never saw any MCP tools — only interactive startup
        # paths called discover_mcp_tools(). Idempotent: subsequent
        # ticks short-circuit on already-connected servers inside
        # register_mcp_servers(). Non-fatal on failure: a broken MCP server
        # shouldn't kill an otherwise-working cron job. See #4219.
        try:
            from tools.mcp_tool import discover_mcp_tools
            _mcp_tools = discover_mcp_tools()
            if _mcp_tools:
                logger.info(
                    "Job '%s': %d MCP tool(s) available",
                    job_id, len(_mcp_tools),
                )
        except Exception as _mcp_exc:
            logger.warning(
                "Job '%s': MCP initialization failed (non-fatal): %s",
                job_id, _mcp_exc,
            )

        agent = AIAgent(
            model=model,
            api_key=runtime.get("api_key"),
            base_url=runtime.get("base_url"),
            provider=runtime.get("provider"),
            api_mode=runtime.get("api_mode"),
            acp_command=runtime.get("command"),
            acp_args=runtime.get("args"),
            max_iterations=max_iterations,
            reasoning_config=reasoning_config,
            prefill_messages=prefill_messages,
            fallback_model=fallback_model,
            credential_pool=credential_pool,
            providers_allowed=pr.get("only"),
            providers_ignored=pr.get("ignore"),
            providers_order=pr.get("order"),
            provider_sort=pr.get("sort"),
            openrouter_min_coding_score=(_cfg.get("openrouter") or {}).get("min_coding_score"),
            enabled_toolsets=_resolve_cron_enabled_toolsets(job, _cfg),
            disabled_toolsets=_resolve_cron_disabled_toolsets(_cfg),
            quiet_mode=True,
            # Cron jobs should always inherit the user's SOUL.md identity from
            # FAN_HOME. When a workdir is configured, also inject project
            # context files (AGENTS.md / CLAUDE.md / .cursorrules) from there.
            # Without a workdir, keep cwd context discovery disabled.
            skip_context_files=not bool(_job_workdir),
            load_soul_identity=True,
            skip_memory=True,  # Cron system prompts would corrupt user representations
            platform="cron",
            session_id=_cron_session_id,
            session_db=_session_db,
        )
        
        # Run the agent with an *inactivity*-based timeout: the job can run
        # for hours if it's actively calling tools / receiving stream tokens,
        # but a hung API call or stuck tool with no activity for the configured
        # duration is caught and killed.  Default 600s (10 min inactivity);
        # override via FAN_CRON_TIMEOUT env var.  0 = unlimited.
        #
        # Uses the agent's built-in activity tracker (updated by
        # _touch_activity() on every tool call, API call, and stream delta).
        _raw_cron_timeout = os.getenv("FAN_CRON_TIMEOUT", "").strip()
        if _raw_cron_timeout:
            try:
                _cron_timeout = float(_raw_cron_timeout)
            except (ValueError, TypeError):
                logger.warning(
                    "Invalid FAN_CRON_TIMEOUT=%r; using default 600s",
                    _raw_cron_timeout,
                )
                _cron_timeout = 600.0
        else:
            _cron_timeout = 600.0
        _cron_inactivity_limit = _cron_timeout if _cron_timeout > 0 else None
        _POLL_INTERVAL = 5.0
        _cron_pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        # Preserve scheduler-scoped ContextVar state (for example skill-declared
        # env passthrough registrations) when the cron run hops into the worker
        # thread used for inactivity timeout monitoring.
        _cron_context = contextvars.copy_context()
        _cron_future = _cron_pool.submit(_cron_context.run, agent.run_conversation, prompt)
        _inactivity_timeout = False
        try:
            if _cron_inactivity_limit is None:
                # Unlimited — just wait for the result.
                result = _cron_future.result()
            else:
                result = None
                while True:
                    done, _ = concurrent.futures.wait(
                        {_cron_future}, timeout=_POLL_INTERVAL,
                    )
                    if done:
                        result = _cron_future.result()
                        break
                    # Agent still running — check inactivity.
                    _idle_secs = 0.0
                    if hasattr(agent, "get_activity_summary"):
                        try:
                            _act = agent.get_activity_summary()
                            _idle_secs = _act.get("seconds_since_activity", 0.0)
                        except Exception:
                            pass
                    if _idle_secs >= _cron_inactivity_limit:
                        _inactivity_timeout = True
                        break
        except Exception:
            _cron_pool.shutdown(wait=False, cancel_futures=True)
            raise
        finally:
            _cron_pool.shutdown(wait=False, cancel_futures=True)

        if _inactivity_timeout:
            # Build diagnostic summary from the agent's activity tracker.
            _activity = {}
            if hasattr(agent, "get_activity_summary"):
                try:
                    _activity = agent.get_activity_summary()
                except Exception:
                    pass
            _last_desc = _activity.get("last_activity_desc", "unknown")
            _secs_ago = _activity.get("seconds_since_activity", 0)
            _cur_tool = _activity.get("current_tool")
            _iter_n = _activity.get("api_call_count", 0)
            _iter_max = _activity.get("max_iterations", 0)

            logger.error(
                "Job '%s' idle for %.0fs (inactivity limit %.0fs) "
                "| last_activity=%s | iteration=%s/%s | tool=%s",
                job_name, _secs_ago, _cron_inactivity_limit,
                _last_desc, _iter_n, _iter_max,
                _cur_tool or "none",
            )
            if hasattr(agent, "interrupt"):
                agent.interrupt("Cron job timed out (inactivity)")
            raise TimeoutError(
                f"Cron job '{job_name}' idle for "
                f"{int(_secs_ago)}s (limit {int(_cron_inactivity_limit)}s) "
                f"— last activity: {_last_desc}"
            )

        # Guard against non-dict returns from run_conversation under error conditions
        if not isinstance(result, dict):
            raise RuntimeError(
                f"agent.run_conversation returned {type(result).__name__} instead of dict: {result!r}"
            )

        # If the agent itself reported failure (e.g. all retries exhausted on
        # API errors, model abort, mid-run interrupt), do not silently mark the
        # job as successful. run_agent populates `failed=True`/`completed=False`
        # on these paths and may put the error into `final_response`, which
        # would otherwise be saved as if it were a successful reply and the
        # job's `last_status` set to "ok". Raise so the except handler below
        # builds the proper failure tuple. (issue #17855)
        turn_exit_reason = str(result.get("turn_exit_reason") or "")
        _fallback_response = (result.get("final_response") or "").strip()
        _iteration_fallback = (
            result.get("failed") is not True
            and turn_exit_reason.startswith(
                "max_iterations_reached("
            )
            and bool(_fallback_response)
        )
        if (
            result.get("failed") is True
            or (result.get("completed") is False and not _iteration_fallback)
        ):
            _err_text = (
                result.get("error")
                or (result.get("final_response") or "").strip()
                or "agent reported failure"
            )
            raise RuntimeError(_err_text)

        final_response = result.get("final_response", "") or ""
        # Strip leaked placeholder text that upstream may inject on empty completions.
        if final_response.strip() == "(No response generated)":
            final_response = ""
        # Interactive turns intentionally receive a diagnostic explanation for
        # an abnormal empty completion. A cron job with no report must remain
        # silent instead of saving that implementation detail as its result.
        if final_response.strip() and turn_exit_reason:
            try:
                explanation = AIAgent._format_turn_completion_explanation(turn_exit_reason)
            except Exception:
                explanation = ""
            if explanation and final_response.strip() == explanation.strip():
                logger.info(
                    "Job '%s': suppressing empty-turn explanation for cron result (%s)",
                    job_id,
                    turn_exit_reason,
                )
                final_response = ""
        # Use a separate variable for log display; keep final_response clean
        # so an empty response remains an empty local result.
        logged_response = final_response if final_response else "(No response generated)"
        
        output = f"""# Cron Job: {job_name}

**Job ID:** {job_id}
**Run Time:** {_fan_now().strftime('%Y-%m-%d %H:%M:%S')}
**Schedule:** {job.get('schedule_display', 'N/A')}

## Prompt

{prompt}

## Response

{logged_response}
"""
        
        logger.info("Job '%s' completed successfully", job_name)
        return True, output, final_response, None
        
    except Exception as e:
        error_msg = f"{type(e).__name__}: {str(e)}"
        logger.exception("Job '%s' failed: %s", job_name, error_msg)
        
        output = f"""# Cron Job: {job_name} (FAILED)

**Job ID:** {job_id}
**Run Time:** {_fan_now().strftime('%Y-%m-%d %H:%M:%S')}
**Schedule:** {job.get('schedule_display', 'N/A')}

## Prompt

{prompt}

## Error

```
{error_msg}
```
"""
        return False, output, "", error_msg

    finally:
        # Restore TERMINAL_CWD to whatever it was before this job ran.  We
        # only ever mutate it when the job has a workdir; see the setup block
        # at the top of run_job for the serialization guarantee.
        if _job_workdir:
            if _prior_terminal_cwd == "_UNSET_":
                os.environ.pop("TERMINAL_CWD", None)
            else:
                os.environ["TERMINAL_CWD"] = _prior_terminal_cwd
        if _holds_cwd_write:
            _terminal_cwd_lock.release_write()
        else:
            _terminal_cwd_lock.release_read()
        # Clean up local session state for this job.
        if _session_db:
            try:
                _session_db.end_session(_cron_session_id, "cron_complete")
            except (Exception, KeyboardInterrupt) as e:
                logger.debug("Job '%s': failed to end session: %s", job_id, e)
            try:
                _session_db.close()
            except (Exception, KeyboardInterrupt) as e:
                logger.debug("Job '%s': failed to close SQLite session store: %s", job_id, e)
        # Release subprocesses, terminal sandboxes, browser daemons, and the
        # main OpenAI/httpx client held by this ephemeral cron agent. Without
        # this, a long-running desktop backend leaks fds per job
        # until it hits EMFILE (#10200 / "too many open files").
        try:
            if agent is not None:
                agent.close()
        except (Exception, KeyboardInterrupt) as e:
            logger.debug("Job '%s': failed to close agent resources: %s", job_id, e)
        # Each cron run spins up a short-lived worker thread whose event loop
        # dies as soon as the ``ThreadPoolExecutor`` shuts down. Any async
        # httpx clients cached under that loop are now unusable — reap them
        # so their transports don't accumulate in the process-global cache.
        try:
            from agent.auxiliary_client import cleanup_stale_async_clients
            cleanup_stale_async_clients()
        except Exception as e:
            logger.debug("Job '%s': failed to reap stale auxiliary clients: %s", job_id, e)


def run_one_job(
    job: dict,
    *,
    verbose: bool = False,
) -> bool:
    """Run one already-claimed cron job through the canonical fire path."""
    claim_token = _claim_token_for_job(job)
    try:
        success, output, final_response, error = run_job(job)

        if not job_run_claim_is_current(job["id"], claim_token):
            logger.error(
                "Discarding late Cron result for job '%s': its run claim now "
                "belongs to another owner",
                job.get("name", job["id"]),
            )
            return False

        output_file = save_job_output(job["id"], output)
        if verbose:
            logger.info("Output saved to: %s", output_file)

        if success and not final_response.strip():
            success = False
            error = (
                "Agent completed but produced empty response "
                "(model error, timeout, or misconfiguration)"
            )

        return mark_job_run(
            job["id"],
            success,
            error,
            claim_token=claim_token,
        )
    except Exception as exc:
        logger.error("Error processing job %s: %s", job["id"], exc)
        mark_job_run(
            job["id"],
            False,
            str(exc),
            claim_token=claim_token,
        )
        return False


def tick(verbose: bool = True, sync: bool = True) -> int:
    """
    Check and run all due jobs.
    
    Uses a file lock so only one tick runs at a time, even if the desktop
    backend ticker and a standalone daemon or manual tick overlap.
    
    Args:
        verbose: Whether to print status messages
    Returns:
        Number of jobs executed (0 if another tick is already running)
    """
    lock_dir, lock_file = _get_lock_paths()
    lock_dir.mkdir(parents=True, exist_ok=True)

    # Cross-platform file locking: fcntl on Unix, msvcrt on Windows
    lock_fd = None
    try:
        lock_fd = open(lock_file, "w", encoding="utf-8")
        if fcntl:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        elif msvcrt:
            msvcrt.locking(lock_fd.fileno(), msvcrt.LK_NBLCK, 1)
    except (OSError, IOError):
        logger.debug("Tick skipped — another instance holds the lock")
        if lock_fd is not None:
            lock_fd.close()
        return 0

    try:
        due_candidates = get_due_jobs()

        if verbose and not due_candidates:
            logger.info("%s - No jobs due", _fan_now().strftime('%H:%M:%S'))
            return 0

        # Convert due snapshots into persistent store claims before releasing
        # the tick lock. Each CAS re-checks the exact scheduled timestamp and
        # advances recurring schedules atomically; one-shot timestamps remain
        # fenced by the claim until their owner finishes.
        due_jobs: list[dict] = []
        for candidate in due_candidates:
            job_id = candidate["id"]
            with _running_lock:
                already_running_here = job_id in _running_job_ids
            if already_running_here:
                logger.info(
                    "Job '%s' already running in this process — skipping claim",
                    candidate.get("name", job_id),
                )
                continue
            claimed = claim_job_for_fire(
                job_id,
                expected_scheduled_for=str(candidate.get("next_run_at") or ""),
            )
            if claimed is not None:
                due_jobs.append(claimed)

        if not due_jobs:
            if verbose:
                logger.info(
                    "%s - Due jobs are already claimed or changed",
                    _fan_now().strftime('%H:%M:%S'),
                )
            return 0

        if verbose:
            logger.info(
                "%s - %s job(s) claimed for execution",
                _fan_now().strftime('%H:%M:%S'),
                len(due_jobs),
            )

        # Resolve max parallel workers: env var > config.yaml > unbounded.
        # Set FAN_CRON_MAX_PARALLEL=1 to restore old serial behaviour.
        _max_workers: Optional[int] = None
        try:
            _env_par = os.getenv("FAN_CRON_MAX_PARALLEL", "").strip()
            if _env_par:
                _max_workers = int(_env_par) or None
        except (ValueError, TypeError):
            logger.warning("Invalid FAN_CRON_MAX_PARALLEL value; defaulting to unbounded")
        if _max_workers is None:
            try:
                _ucfg = load_config() or {}
                _cfg_par = (
                    _ucfg.get("cron", {}) if isinstance(_ucfg, dict) else {}
                ).get("max_parallel_jobs")
                if _cfg_par is not None:
                    _max_workers = int(_cfg_par) or None
            except Exception:
                pass

        if verbose:
            logger.info(
                "Running %d job(s) in parallel (max_workers=%s)",
                len(due_jobs),
                _max_workers if _max_workers else "unbounded",
            )

        def _process_job(job: dict) -> bool:
            """Run one due job end-to-end: execute, save, and mark."""
            return run_one_job(
                job,
                verbose=verbose,
            )

        # Partition workdir jobs onto one executor. The per-run read/write lock
        # in run_job additionally prevents a workdir-less parallel job from
        # observing a workdir override while that executor is active.
        sequential_jobs = [
            j for j in due_jobs
            if (j.get("workdir") or "").strip()
        ]
        parallel_jobs = [
            j for j in due_jobs
            if not (j.get("workdir") or "").strip()
        ]

        _results: list = []
        _all_futures: list = []

        def _submit_with_guard(job: dict, pool: concurrent.futures.ThreadPoolExecutor):
            """Submit a job fire-and-forget with the in-flight dedup guard.

            Returns the future, or None if the job was skipped because a prior
            tick's run of the same job is still in flight.  The running-set
            membership is released in the worker's finally block.
            """
            job_id = job["id"]
            claim_token = _claim_token_for_job(job)
            if not claim_token:
                logger.error(
                    "Job '%s' reached submission without a run claim — skipping",
                    job.get("name", job_id),
                )
                return None
            with _running_lock:
                if job_id in _running_job_ids:
                    logger.info("Job '%s' already running — skipping", job.get("name", job_id))
                    release_job_run_claim(job_id, claim_token)
                    return None
                _running_job_ids.add(job_id)
            _ctx = contextvars.copy_context()
            heartbeat_stop, heartbeat_thread = _start_claim_heartbeat(job)

            def _run_and_release(j=job, ctx=_ctx):
                try:
                    return ctx.run(_process_job, j)
                finally:
                    _stop_claim_heartbeat(heartbeat_stop, heartbeat_thread)
                    with _running_lock:
                        _running_job_ids.discard(j["id"])

            try:
                return pool.submit(_run_and_release)
            except Exception:
                _stop_claim_heartbeat(heartbeat_stop, heartbeat_thread)
                with _running_lock:
                    _running_job_ids.discard(job_id)
                release_job_run_claim(job_id, claim_token)
                raise

        # Sequential pass for env/context-mutating workdir jobs.
        # Queued to a persistent single-thread pool so they run one at a time
        # WITHOUT blocking the ticker thread — a long workdir job no
        # longer starves the rest of the schedule (same fix as the parallel
        # pass, just serialized).  The in-flight guard prevents a still-running
        # job from being re-queued on the next tick.
        if sequential_jobs:
            seq_pool = _get_sequential_pool()
            for job in sequential_jobs:
                fut = _submit_with_guard(job, seq_pool)
                if fut is None:
                    continue
                _all_futures.append(fut)
                if not sync:
                    _results.append(True)  # optimistically counted

        # Parallel pass — persistent pool, non-blocking dispatch.
        # Jobs that are already running (from a previous tick) are skipped.
        # mark_job_run() updates next_run_at on completion, so the next tick
        # after completion finds the job due again naturally.  No catch-up
        # queue needed.
        if parallel_jobs:
            pool = _get_parallel_pool(_max_workers)
            for job in parallel_jobs:
                fut = _submit_with_guard(job, pool)
                if fut is None:
                    continue
                _all_futures.append(fut)
                if not sync:
                    _results.append(True)  # optimistically counted

        # Best-effort sweep of MCP stdio subprocesses that survived their
        # session teardown.  Must run AFTER jobs finish so active sessions
        # (including live user chats) are never touched — only PIDs explicitly
        # detected as orphans in tools.mcp_tool._run_stdio's finally block are
        # reaped.
        def _sweep_mcp_orphans() -> None:
            try:
                from tools.mcp_tool import _kill_orphaned_mcp_children
                _kill_orphaned_mcp_children()
            except Exception as _e:
                logger.debug("Post-tick MCP orphan cleanup failed: %s", _e)

        if sync:
            # Sync mode (tests / manual ticks): wait for all dispatched jobs,
            # collect results, then sweep once.
            for f in concurrent.futures.as_completed(_all_futures):
                try:
                    _results.append(f.result())
                except Exception as exc:
                    logger.error("Cron job future failed: %s", exc)
                    _results.append(False)
            _sweep_mcp_orphans()
            return sum(_results)

        # Async ticker mode: don't block. Sweep orphans via a
        # done-callback fired after the LAST dispatched job completes, so the
        # sweep still happens after jobs finish without stalling the tick.
        if _all_futures:
            _remaining = [len(_all_futures)]

            def _on_done(_f: concurrent.futures.Future) -> None:
                _remaining[0] -= 1
                try:
                    _exc = _f.exception()
                    if _exc is not None:
                        logger.error(
                            "Cron job future failed in async mode: %s",
                            _exc,
                            exc_info=(type(_exc), _exc, _exc.__traceback__),
                        )
                except Exception:
                    logger.debug(
                        "Unable to inspect completed cron future", exc_info=True
                    )
                if _remaining[0] <= 0:
                    _sweep_mcp_orphans()

            for _f in _all_futures:
                _f.add_done_callback(_on_done)
        else:
            # Nothing dispatched (all skipped / no due jobs) — sweep inline.
            _sweep_mcp_orphans()

        return sum(_results)
    finally:
        if fcntl:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            except (OSError, IOError):
                pass
        elif msvcrt:
            try:
                msvcrt.locking(lock_fd.fileno(), msvcrt.LK_UNLCK, 1)
            except (OSError, IOError):
                pass
        lock_fd.close()


if __name__ == "__main__":
    tick(verbose=True)


# ---------------------------------------------------------------------------
# In-process background ticker
# ---------------------------------------------------------------------------
# The desktop backend (``fan dashboard`` → web_server.start_server) is the
# product's long-lived process, so it owns the automatic scheduler: a daemon
# thread that calls tick() on a fixed interval. tick() already holds a
# cross-process file lock and advances next_run_at under it (at-most-once),
# so overlap with a manual ``fan cron tick`` or a second dashboard instance
# is safe — one of them simply no-ops.

_ticker_started = False
_ticker_lock = threading.Lock()

DEFAULT_TICK_INTERVAL_SECONDS = 30.0


def start_background_ticker(interval_seconds: Optional[float] = None) -> bool:
    """Start the cron ticker thread (idempotent per process).

    Interval resolution: explicit arg > config ``cron.tick_seconds`` >
    30s default (cron granularity is minutes; 30s catches boundaries
    promptly without meaningful load — a no-op tick is one sqlite read).
    Returns True when this call actually started the thread.
    """
    global _ticker_started
    with _ticker_lock:
        if _ticker_started:
            return False
        _ticker_started = True

    if interval_seconds is None:
        interval_seconds = DEFAULT_TICK_INTERVAL_SECONDS
        try:
            _cfg = load_config() or {}
            _raw = (_cfg.get("cron") or {}).get("tick_seconds")
            if _raw is not None:
                interval_seconds = max(5.0, float(_raw))
        except Exception:
            logger.warning("cron ticker: bad cron.tick_seconds config; using %.0fs",
                           DEFAULT_TICK_INTERVAL_SECONDS)

    def _loop():
        # Head start so a tick isn't competing with dashboard boot I/O.
        record_ticker_heartbeat()
        time.sleep(5.0)
        while True:
            succeeded = False
            try:
                # sync=False: submit due jobs to the executor and return —
                # a long job must never stall the ticker cadence.
                tick(verbose=False, sync=False)
                succeeded = True
            except BaseException:
                # Gateway shutdown is controlled by the main thread. A
                # provider or agent raising SystemExit/KeyboardInterrupt in
                # this daemon thread must not silently kill scheduling.
                logger.error(
                    "cron ticker: tick failed; continuing on next interval",
                    exc_info=True,
                )
            record_ticker_heartbeat(success=succeeded)
            time.sleep(interval_seconds)

    threading.Thread(target=_loop, name="cron-ticker", daemon=True).start()
    logger.info("cron ticker started (interval %.0fs)", interval_seconds)
    return True
