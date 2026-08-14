from __future__ import annotations

from datetime import timedelta

import pytest

from cron import jobs as jobs_module


@pytest.fixture
def cron_store(tmp_path, monkeypatch):
    cron_dir = tmp_path / "cron"
    monkeypatch.setattr(jobs_module, "CRON_DIR", cron_dir)
    monkeypatch.setattr(jobs_module, "JOBS_FILE", cron_dir / "jobs.json")
    monkeypatch.setattr(jobs_module, "OUTPUT_DIR", cron_dir / "output")
    return cron_dir


def _good_due_job():
    now = jobs_module._fan_now()
    run_at = (now - timedelta(seconds=20)).isoformat()
    return {
        "id": "good-sibling",
        "name": "good",
        "schedule": {"kind": "once", "run_at": run_at},
        "next_run_at": run_at,
        "enabled": True,
    }


@pytest.mark.parametrize(
    "poison",
    [
        "not-an-object",
        {"name": "missing-id", "schedule": {"kind": "once"}, "enabled": True},
        {"id": "bad-schedule", "schedule": [], "enabled": True},
        {
            "id": "bad-time",
            "schedule": {"kind": "interval", "minutes": 5},
            "next_run_at": "definitely-not-an-iso-date",
            "enabled": True,
        },
    ],
)
def test_malformed_job_never_starves_healthy_sibling(cron_store, poison):
    jobs_module.save_jobs([poison, _good_due_job()])

    due = jobs_module.get_due_jobs()

    assert [job["id"] for job in due] == ["good-sibling"]
    persisted = jobs_module.load_jobs()
    assert persisted[0] == poison
