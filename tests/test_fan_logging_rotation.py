import importlib
import logging.handlers
import os
import stat
import sys
from types import ModuleType

import pytest

import fan_logging


def test_posix_logging_keeps_stdlib_rotating_handler():
    if sys.platform == "win32":
        return

    assert fan_logging.RotatingFileHandler is logging.handlers.RotatingFileHandler
    assert issubclass(fan_logging._ManagedRotatingFileHandler, logging.handlers.RotatingFileHandler)


def test_windows_logging_selects_the_concurrent_handler(monkeypatch):
    class FakeConcurrentRotatingFileHandler(logging.Handler):
        pass

    fake_module = ModuleType("concurrent_log_handler")
    fake_module.ConcurrentRotatingFileHandler = FakeConcurrentRotatingFileHandler

    with monkeypatch.context() as patch:
        patch.setattr(sys, "platform", "win32")
        patch.setitem(sys.modules, "concurrent_log_handler", fake_module)
        reloaded = importlib.reload(fan_logging)

        assert reloaded.RotatingFileHandler is FakeConcurrentRotatingFileHandler
        assert issubclass(reloaded._ManagedRotatingFileHandler, FakeConcurrentRotatingFileHandler)

    importlib.reload(fan_logging)


@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits are not portable to Windows")
@pytest.mark.parametrize(
    ("managed", "expected_mode"),
    ((False, 0o600), (True, 0o660)),
)
def test_rotating_handler_applies_profile_permissions_after_open_and_rollover(
    monkeypatch,
    tmp_path,
    managed,
    expected_mode,
):
    from fan_cli import config

    monkeypatch.setattr(config, "is_managed", lambda: managed)
    log_path = tmp_path / "agent.log"
    old_backup = tmp_path / "agent.log.1"
    log_path.write_text("existing record\n", encoding="utf-8")
    old_backup.write_text("legacy backup\n", encoding="utf-8")
    log_path.chmod(0o644)
    old_backup.chmod(0o644)
    handler = fan_logging._ManagedRotatingFileHandler(
        log_path,
        maxBytes=128,
        backupCount=1,
        encoding="utf-8",
    )
    try:
        assert stat.S_IMODE(log_path.stat().st_mode) == expected_mode
        assert stat.S_IMODE(old_backup.stat().st_mode) == expected_mode

        handler.stream.write("new record\n")
        handler.stream.flush()
        handler.doRollover()

        assert stat.S_IMODE(log_path.stat().st_mode) == expected_mode
        assert stat.S_IMODE((tmp_path / "agent.log.1").stat().st_mode) == expected_mode
    finally:
        handler.close()


@pytest.mark.skipif(os.name == "nt", reason="symlink semantics vary on Windows")
def test_rotating_handler_refuses_symlink_without_touching_target(
    monkeypatch,
    tmp_path,
):
    from fan_cli import config

    monkeypatch.setattr(config, "is_managed", lambda: False)
    target = tmp_path / "outside.log"
    target.write_text("untouched", encoding="utf-8")
    target.chmod(0o644)
    link = tmp_path / "agent.log"
    link.symlink_to(target)

    with pytest.raises(OSError):
        fan_logging._ManagedRotatingFileHandler(
            link,
            maxBytes=128,
            backupCount=1,
            encoding="utf-8",
        )

    assert target.read_text(encoding="utf-8") == "untouched"
    assert stat.S_IMODE(target.stat().st_mode) == 0o644
