import json

import pytest

from cron import jobs as jobs_module
from fan_cli.dump import _cron_summary


@pytest.fixture
def cron_store(tmp_path, monkeypatch):
    cron_dir = tmp_path / "cron"
    monkeypatch.setattr(jobs_module, "CRON_DIR", cron_dir)
    monkeypatch.setattr(jobs_module, "JOBS_FILE", cron_dir / "jobs.json")
    monkeypatch.setattr(jobs_module, "OUTPUT_DIR", cron_dir / "output")
    cron_dir.mkdir()
    return cron_dir


def test_load_jobs_accepts_utf8_bom(cron_store):
    payload = {"jobs": [{"id": "bom-job", "enabled": True}]}
    jobs_module.JOBS_FILE.write_bytes(
        b"\xef\xbb\xbf" + json.dumps(payload).encode("utf-8")
    )

    assert jobs_module.load_jobs() == payload["jobs"]


def test_load_jobs_bom_control_character_uses_repair_path(cron_store):
    jobs_module.JOBS_FILE.write_bytes(
        b'\xef\xbb\xbf{"jobs": [{"id": "ctrl-job", "name": "line\nbreak"}]}'
    )

    loaded = jobs_module.load_jobs()

    assert loaded[0]["name"] == "line\nbreak"
    assert not jobs_module.JOBS_FILE.read_bytes().startswith(b"\xef\xbb\xbf")


def test_load_jobs_bom_bare_list_is_repaired_without_bom(cron_store):
    payload = [{"id": "bare-job", "enabled": True}]
    jobs_module.JOBS_FILE.write_bytes(
        b"\xef\xbb\xbf" + json.dumps(payload).encode("utf-8")
    )

    assert jobs_module.load_jobs() == payload
    rewritten = jobs_module.JOBS_FILE.read_bytes()
    assert not rewritten.startswith(b"\xef\xbb\xbf")
    assert json.loads(rewritten)["jobs"] == payload


def test_dump_cron_summary_accepts_utf8_bom(tmp_path):
    cron_dir = tmp_path / "cron"
    cron_dir.mkdir()
    (cron_dir / "jobs.json").write_bytes(
        b'\xef\xbb\xbf{"jobs": ['
        b'{"id": "one", "enabled": true},'
        b'{"id": "two", "enabled": false}]}'
    )

    assert _cron_summary(tmp_path) == "1 active / 2 total"
