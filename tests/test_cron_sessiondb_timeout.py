import concurrent.futures
import logging
import threading
import time

from cron import scheduler
from fan_cli.config import DEFAULT_CONFIG
import fan_state


def test_default_config_bounds_cron_session_db_initialization():
    assert DEFAULT_CONFIG["cron"]["session_db_timeout_seconds"] == 10


def test_session_db_timeout_resolves_from_config(monkeypatch):
    monkeypatch.setattr(
        scheduler,
        "load_config",
        lambda: {"cron": {"session_db_timeout_seconds": 0.25}},
    )

    assert scheduler._get_session_db_timeout() == 0.25


def test_invalid_session_db_timeout_uses_safe_default(monkeypatch, caplog):
    monkeypatch.setattr(
        scheduler,
        "load_config",
        lambda: {"cron": {"session_db_timeout_seconds": "invalid"}},
    )

    with caplog.at_level(logging.WARNING, logger="cron.scheduler"):
        timeout = scheduler._get_session_db_timeout()

    assert timeout == scheduler._DEFAULT_SESSION_DB_TIMEOUT
    assert "Invalid cron.session_db_timeout_seconds" in caplog.text


def test_hung_session_db_initialization_fails_open_within_bound(
    monkeypatch,
    caplog,
):
    release = threading.Event()

    def hanging_session_db():
        release.wait(timeout=5)
        return object()

    monkeypatch.setattr(scheduler, "_get_session_db_timeout", lambda: 0.1)
    monkeypatch.setattr(fan_state, "SessionDB", hanging_session_db)

    started = time.monotonic()
    try:
        with caplog.at_level(logging.ERROR, logger="cron.scheduler"):
            result = scheduler._init_session_db_bounded("hung-job")
    finally:
        release.set()

    assert result is None
    assert time.monotonic() - started < 1
    assert "continuing without session persistence" in caplog.text


def test_successful_session_db_initialization_is_returned(monkeypatch):
    expected = object()
    monkeypatch.setattr(scheduler, "_get_session_db_timeout", lambda: 1.0)
    monkeypatch.setattr(fan_state, "SessionDB", lambda: expected)

    assert scheduler._init_session_db_bounded("healthy-job") is expected


def test_scheduler_releases_running_guard_after_session_db_timeout(
    tmp_path,
    monkeypatch,
):
    release = threading.Event()
    dispatched = []
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    candidate = {
        "id": "guard-job",
        "name": "guard job",
        "next_run_at": "2026-07-23T00:00:00+00:00",
    }
    claimed = {
        **candidate,
        "run_claim": {"token": "guard-token"},
    }

    monkeypatch.setattr(scheduler, "_get_lock_paths", lambda: (
        tmp_path,
        tmp_path / ".tick.lock",
    ))
    monkeypatch.setattr(scheduler, "get_due_jobs", lambda: [candidate])
    monkeypatch.setattr(scheduler, "claim_job_for_fire", lambda *args, **kwargs: claimed)
    monkeypatch.setattr(scheduler, "_get_parallel_pool", lambda _workers: pool)
    monkeypatch.setattr(
        scheduler,
        "_start_claim_heartbeat",
        lambda _job: (threading.Event(), object()),
    )
    monkeypatch.setattr(scheduler, "_stop_claim_heartbeat", lambda *_args: None)
    monkeypatch.setattr(scheduler, "_get_session_db_timeout", lambda: 0.05)
    monkeypatch.setattr(
        fan_state,
        "SessionDB",
        lambda: release.wait(timeout=5),
    )

    def run_one_job(job, **_kwargs):
        dispatched.append(job["id"])
        scheduler._init_session_db_bounded(job["id"])
        return False

    monkeypatch.setattr(scheduler, "run_one_job", run_one_job)
    scheduler._running_job_ids.clear()
    try:
        scheduler.tick(verbose=False, sync=True)
        assert "guard-job" not in scheduler._running_job_ids

        scheduler.tick(verbose=False, sync=True)
        assert dispatched == ["guard-job", "guard-job"]
    finally:
        release.set()
        scheduler._running_job_ids.clear()
        pool.shutdown(wait=True)
