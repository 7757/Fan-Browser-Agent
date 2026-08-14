import logging

import pytest

from agent.skill_commands import scan_skill_commands
from agent import skill_utils
from tools import skills_tool


def _write_skill(root, directory, name, description="Test skill."):
    skill_dir = root / directory
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\nBody.\n",
        encoding="utf-8",
    )
    return skill_dir


@pytest.fixture
def skill_root(tmp_path, monkeypatch):
    monkeypatch.setattr(skills_tool, "SKILLS_DIR", tmp_path)
    monkeypatch.setattr(skill_utils, "get_external_skills_dirs", lambda: [])
    monkeypatch.setattr(skills_tool, "_get_disabled_skill_names", lambda: set())
    return tmp_path


@pytest.mark.parametrize("name", ["skills", "bg"])
def test_core_command_and_alias_collisions_are_skipped(skill_root, name, caplog):
    _write_skill(skill_root, name, name)

    with caplog.at_level(logging.WARNING, logger="agent.skill_commands"):
        commands = scan_skill_commands()

    assert f"/{name}" not in commands
    assert "collides with a core Fan command" in caplog.text


def test_core_collision_does_not_hide_unrelated_skill(skill_root):
    _write_skill(skill_root, "a-core", "skills")
    custom_dir = _write_skill(skill_root, "b-custom", "my-helper")

    commands = scan_skill_commands()

    assert "/skills" not in commands
    assert commands["/my-helper"]["skill_dir"] == str(custom_dir)


def test_normalized_slug_collision_keeps_first_skill(skill_root, caplog):
    first_dir = _write_skill(skill_root, "a-first", "git_helper", "First skill.")
    _write_skill(skill_root, "z-second", "git-helper", "Second skill.")

    with caplog.at_level(logging.WARNING, logger="agent.skill_commands"):
        commands = scan_skill_commands()

    assert commands["/git-helper"]["name"] == "git_helper"
    assert commands["/git-helper"]["skill_dir"] == str(first_dir)
    assert "already claimed" in caplog.text
