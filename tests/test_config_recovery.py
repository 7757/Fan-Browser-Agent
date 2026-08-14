from __future__ import annotations

import time

import pytest

from fan_cli import config as config_module


@pytest.fixture
def isolated_config(tmp_path, monkeypatch):
    monkeypatch.setenv("FAN_HOME", str(tmp_path))
    config_module._LOAD_CONFIG_CACHE.clear()
    config_module._RAW_CONFIG_CACHE.clear()
    config_module._LAST_EXPANDED_CONFIG_BY_PATH.clear()
    config_module._CONFIG_PARSE_WARNED.clear()
    yield tmp_path
    config_module._LOAD_CONFIG_CACHE.clear()
    config_module._RAW_CONFIG_CACHE.clear()
    config_module._LAST_EXPANDED_CONFIG_BY_PATH.clear()
    config_module._CONFIG_PARSE_WARNED.clear()


def _change_file_timestamp(path):
    time.sleep(0.01)
    path.touch()


def test_broken_edit_keeps_in_process_last_known_good(isolated_config):
    path = isolated_config / "config.yaml"
    path.write_text("model:\n  default: safe-model\n", encoding="utf-8")
    assert config_module.load_config()["model"]["default"] == "safe-model"

    path.write_text("model: [unclosed\n", encoding="utf-8")
    _change_file_timestamp(path)

    assert config_module.load_config()["model"]["default"] == "safe-model"
    assert path.read_text(encoding="utf-8") == "model: [unclosed\n"


def test_durable_last_known_good_survives_runtime_cache_loss(isolated_config):
    path = isolated_config / "config.yaml"
    path.write_text("model:\n  default: durable-model\n", encoding="utf-8")
    config_module.load_config()
    assert (isolated_config / "config.validated.yaml").exists()

    config_module._LOAD_CONFIG_CACHE.clear()
    config_module._LAST_EXPANDED_CONFIG_BY_PATH.clear()
    path.write_text("model: [unclosed\n", encoding="utf-8")
    _change_file_timestamp(path)

    assert config_module.load_config()["model"]["default"] == "durable-model"


def test_save_refuses_to_clobber_malformed_existing_config(isolated_config):
    path = isolated_config / "config.yaml"
    broken = "model: [unclosed\n"
    path.write_text(broken, encoding="utf-8")

    with pytest.raises(RuntimeError, match="Refusing to overwrite"):
        config_module.save_config({"model": {"default": "replacement"}})

    assert path.read_text(encoding="utf-8") == broken


def test_new_profile_can_still_be_written(isolated_config):
    config_module.save_config({"model": {"default": "new-model"}})
    assert config_module.load_config()["model"]["default"] == "new-model"
