from __future__ import annotations

import logging

import pytest

from tools import credential_files


@pytest.fixture(autouse=True)
def _isolated_registry(monkeypatch):
    credential_files._registered_files_var.set({})
    monkeypatch.setattr(credential_files, "_config_files", [])


def _fan_home(tmp_path, monkeypatch):
    fan_home = tmp_path / ".fan"
    fan_home.mkdir()
    monkeypatch.setenv("FAN_HOME", str(fan_home))
    monkeypatch.setattr(credential_files, "_resolve_fan_home", lambda: fan_home)
    return fan_home


@pytest.mark.parametrize(
    "relative_path",
    [
        ".env",
        "auth.json",
        ".anthropic_oauth.json",
        "cache/bws_cache.json",
        "mcp-tokens/service.json",
    ],
)
def test_master_credential_store_is_never_mountable(
    tmp_path,
    monkeypatch,
    relative_path,
):
    fan_home = _fan_home(tmp_path, monkeypatch)
    target = fan_home / relative_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("secret", encoding="utf-8")

    assert credential_files.register_credential_file(relative_path) is False
    assert credential_files.get_credential_file_mounts() == []


def test_skill_service_token_remains_mountable(tmp_path, monkeypatch):
    fan_home = _fan_home(tmp_path, monkeypatch)
    (fan_home / "google_token.json").write_text("{}", encoding="utf-8")

    assert credential_files.register_credential_file("google_token.json") is True
    assert credential_files.get_credential_file_mounts() == [
        {
            "host_path": str((fan_home / "google_token.json").resolve()),
            "container_path": "/root/.fan/google_token.json",
        }
    ]


def test_missing_or_raising_guard_fails_closed(tmp_path, monkeypatch, caplog):
    fan_home = _fan_home(tmp_path, monkeypatch)
    (fan_home / "google_token.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr(credential_files, "get_read_block_error", None)
    with caplog.at_level(logging.ERROR, logger="tools.credential_files"):
        assert credential_files.register_credential_file("google_token.json") is False
    assert "deny-list cannot be consulted" in caplog.text

    caplog.clear()

    def _raise_guard(_path):
        raise RuntimeError("guard failed")

    monkeypatch.setattr(credential_files, "get_read_block_error", _raise_guard)
    with caplog.at_level(logging.ERROR, logger="tools.credential_files"):
        assert credential_files.register_credential_file("google_token.json") is False
    assert "read guard raised" in caplog.text
