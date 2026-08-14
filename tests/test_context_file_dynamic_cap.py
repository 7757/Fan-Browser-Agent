from pathlib import Path
from types import SimpleNamespace

from agent.prompt_builder import (
    CONTEXT_FILE_MAX_CHARS,
    _CONTEXT_FILE_DYNAMIC_CEILING,
    _dynamic_context_file_max_chars,
    _get_context_file_max_chars,
    _load_cursorrules,
    _load_fan_md,
    _truncate_content,
)
from agent.system_prompt import build_system_prompt_parts


def test_context_file_cap_scales_with_model_window():
    assert _dynamic_context_file_max_chars(None) == CONTEXT_FILE_MAX_CHARS
    assert _dynamic_context_file_max_chars(0) == CONTEXT_FILE_MAX_CHARS
    assert _dynamic_context_file_max_chars(True) == CONTEXT_FILE_MAX_CHARS
    assert _dynamic_context_file_max_chars(8_000) == CONTEXT_FILE_MAX_CHARS
    assert _dynamic_context_file_max_chars(200_000) == 48_000
    assert _dynamic_context_file_max_chars(100_000_000) == _CONTEXT_FILE_DYNAMIC_CEILING


def test_internal_fixed_cap_wins_and_boolean_is_not_an_integer(monkeypatch):
    monkeypatch.setattr(
        "fan_cli.config.load_config",
        lambda: {"context_file_max_chars": 12_345},
    )
    assert _get_context_file_max_chars(200_000) == 12_345

    monkeypatch.setattr(
        "fan_cli.config.load_config",
        lambda: {"context_file_max_chars": True},
    )
    assert _get_context_file_max_chars(200_000) == 48_000


def test_large_window_keeps_medium_file_and_marker_names_real_path(monkeypatch):
    monkeypatch.setattr("fan_cli.config.load_config", lambda: {})
    content = "规则" * 15_000

    small = _truncate_content(
        content,
        "AGENTS.md",
        context_length=8_000,
        read_path="/workspace/AGENTS.md",
    )
    large = _truncate_content(content, "AGENTS.md", context_length=200_000)

    assert "read_file" in small
    assert "/workspace/AGENTS.md" in small
    assert large == content


def test_parent_fan_file_marker_uses_discovered_path(tmp_path, monkeypatch):
    monkeypatch.setattr("fan_cli.config.load_config", lambda: {})
    (tmp_path / ".git").mkdir()
    fan_file = tmp_path / "FAN.md"
    fan_file.write_text("project rule\n" * 3_000, encoding="utf-8")
    nested = tmp_path / "src" / "feature"
    nested.mkdir(parents=True)

    result = _load_fan_md(nested, context_length=8_000)

    assert "read_file" in result
    assert str(fan_file) in result


def test_aggregated_cursor_rules_marker_lists_each_real_source(tmp_path, monkeypatch):
    monkeypatch.setattr("fan_cli.config.load_config", lambda: {})
    rules = tmp_path / ".cursor" / "rules"
    rules.mkdir(parents=True)
    first = rules / "first.mdc"
    second = rules / "second.mdc"
    first.write_text("first rule\n" * 1_200, encoding="utf-8")
    second.write_text("second rule\n" * 1_200, encoding="utf-8")

    result = _load_cursorrules(tmp_path, context_length=8_000)

    assert "read_file" in result
    assert str(first) in result
    assert str(second) in result
    assert str(tmp_path / ".cursorrules") not in result


def test_system_prompt_forwards_resolved_window_to_context_loaders(monkeypatch):
    import run_agent

    seen = {}

    def load_soul(context_length=None):
        seen["soul"] = context_length
        return ""

    def load_context(**kwargs):
        seen["context"] = kwargs
        return ""

    monkeypatch.setattr(run_agent, "load_soul_md", load_soul)
    monkeypatch.setattr(run_agent, "build_context_files_prompt", load_context)
    monkeypatch.setattr(run_agent, "build_environment_hints", lambda: "")

    agent = SimpleNamespace(
        load_soul_identity=True,
        skip_context_files=False,
        valid_tool_names=[],
        _task_completion_guidance=False,
        _environment_probe=False,
        _memory_store=None,
        _memory_manager=None,
        model="",
        provider="",
        platform="",
        pass_session_id=False,
        session_id="",
        context_compressor=SimpleNamespace(context_length=200_000),
    )

    build_system_prompt_parts(agent)

    assert seen["soul"] == 200_000
    assert seen["context"]["context_length"] == 200_000
