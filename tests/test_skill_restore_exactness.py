from pathlib import Path

from tools import skill_usage


def _archived_skill(root: Path, directory_name: str, skill_name: str) -> Path:
    directory = root / "skills" / ".archive" / directory_name
    directory.mkdir(parents=True)
    (directory / "SKILL.md").write_text(
        f"---\nname: {skill_name}\ndescription: test\n---\n",
        encoding="utf-8",
    )
    return directory


def test_restore_does_not_take_unrelated_prefix_sibling(tmp_path, monkeypatch):
    monkeypatch.setattr(skill_usage, "get_fan_home", lambda: tmp_path)
    sibling = _archived_skill(tmp_path, "git-helpers", "git-helpers")

    ok, message = skill_usage.restore_skill("git")

    assert not ok
    assert "not found" in message.lower()
    assert sibling.exists()
    assert not (tmp_path / "skills" / "git").exists()


def test_restore_accepts_exact_timestamped_duplicate(tmp_path, monkeypatch):
    monkeypatch.setattr(skill_usage, "get_fan_home", lambda: tmp_path)
    duplicate = _archived_skill(
        tmp_path,
        "report-tool-20260101000000",
        "report-tool",
    )

    ok, message = skill_usage.restore_skill("report-tool")

    assert ok, message
    assert not duplicate.exists()
    restored = tmp_path / "skills" / "report-tool" / "SKILL.md"
    assert "name: report-tool\n" in restored.read_text(encoding="utf-8")


def test_restore_prefers_timestamped_duplicate_and_leaves_sibling(tmp_path, monkeypatch):
    monkeypatch.setattr(skill_usage, "get_fan_home", lambda: tmp_path)
    duplicate = _archived_skill(tmp_path, "report-20260101000000", "report")
    sibling = _archived_skill(tmp_path, "report-card", "report-card")

    ok, message = skill_usage.restore_skill("report")

    assert ok, message
    assert not duplicate.exists()
    assert sibling.exists()
    restored = (tmp_path / "skills" / "report" / "SKILL.md").read_text(encoding="utf-8")
    assert "name: report\n" in restored
    assert "name: report-card" not in restored


def test_timestamp_shaped_real_sibling_is_not_treated_as_duplicate(tmp_path, monkeypatch):
    monkeypatch.setattr(skill_usage, "get_fan_home", lambda: tmp_path)
    sibling = _archived_skill(
        tmp_path,
        "report-20260101000000",
        "report-20260101000000",
    )

    ok, message = skill_usage.restore_skill("report")

    assert not ok
    assert "not found" in message.lower()
    assert sibling.exists()
    assert not (tmp_path / "skills" / "report").exists()
