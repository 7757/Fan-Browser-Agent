from __future__ import annotations

import os
import stat

import pytest

from agent import llm_io_log


def _reset_log_path(monkeypatch: pytest.MonkeyPatch, fan_home) -> None:
    monkeypatch.setenv("FAN_HOME", str(fan_home))
    monkeypatch.setattr(llm_io_log, "_PATH_CACHE", [None])


def test_llm_io_log_uses_authoritative_install_method_and_explicit_flags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("FAN_LLM_IO_LOG", raising=False)
    monkeypatch.delenv("FAN_DESKTOP_DEV_SERVER", raising=False)

    monkeypatch.setenv("FAN_INSTALL_METHOD", "packaged")
    assert llm_io_log.enabled() is False

    monkeypatch.setenv("FAN_INSTALL_METHOD", "dev")
    assert llm_io_log.enabled() is True

    monkeypatch.setenv("FAN_LLM_IO_LOG", "typo")
    assert llm_io_log.enabled() is False

    monkeypatch.setenv("FAN_INSTALL_METHOD", "packaged")
    monkeypatch.setenv("FAN_LLM_IO_LOG", "full")
    assert llm_io_log.enabled() is True


def test_llm_io_log_is_private_bounded_and_stdout_is_opt_in(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    fan_home = tmp_path / "fan-home"
    _reset_log_path(monkeypatch, fan_home)
    monkeypatch.delenv("FAN_LLM_IO_STDOUT", raising=False)
    monkeypatch.setattr(llm_io_log, "_MAX_BYTES", 512)

    llm_io_log._emit("first", "敏感内容" * 200)
    assert capsys.readouterr().out == ""

    current = fan_home / "llm-io.log"
    assert current.stat().st_size <= 512
    if os.name != "nt":
        assert stat.S_IMODE(current.stat().st_mode) == 0o600

    monkeypatch.setenv("FAN_LLM_IO_STDOUT", "1")
    llm_io_log._emit("second", "small")
    assert "second" in capsys.readouterr().out

    backup = fan_home / "llm-io.log.1"
    assert backup.exists()
    assert backup.stat().st_size <= 512
    assert current.stat().st_size <= 512
    if os.name != "nt":
        assert stat.S_IMODE(backup.stat().st_mode) == 0o600
        assert stat.S_IMODE(current.stat().st_mode) == 0o600


def test_llm_io_log_refuses_symlink_target(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    fan_home = tmp_path / "fan-home"
    fan_home.mkdir()
    target = tmp_path / "outside.log"
    target.write_text("untouched", encoding="utf-8")
    link = fan_home / "llm-io.log"
    try:
        link.symlink_to(target)
    except OSError as error:
        pytest.skip(f"symlinks unavailable: {error}")

    _reset_log_path(monkeypatch, fan_home)
    monkeypatch.delenv("FAN_LLM_IO_STDOUT", raising=False)
    llm_io_log._emit("blocked", "must not escape")

    assert link.is_symlink()
    assert target.read_text(encoding="utf-8") == "untouched"


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits are not portable to Windows")
def test_llm_io_log_tightens_an_existing_backup(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    fan_home = tmp_path / "fan-home"
    fan_home.mkdir()
    backup = fan_home / "llm-io.log.1"
    backup.write_text("legacy sensitive log", encoding="utf-8")
    backup.chmod(0o644)

    _reset_log_path(monkeypatch, fan_home)
    llm_io_log._emit("current", "small")

    assert stat.S_IMODE(backup.stat().st_mode) == 0o600
