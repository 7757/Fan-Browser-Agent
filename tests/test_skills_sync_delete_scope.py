from pathlib import Path

import pytest

from tools import skills_sync


def _set_skills_root(monkeypatch, root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(skills_sync, "SKILLS_DIR", root)


@pytest.mark.parametrize("target_kind", ["filesystem_root", "fan_home", "sibling"])
def test_rmtree_writable_refuses_paths_outside_skills_root(
    monkeypatch, tmp_path, target_kind
):
    fan_home = tmp_path / "fan-home"
    skills_root = fan_home / "skills"
    _set_skills_root(monkeypatch, skills_root)

    if target_kind == "filesystem_root":
        target = Path(skills_root.anchor)
    elif target_kind == "fan_home":
        target = fan_home
    else:
        target = fan_home / "memory"
        target.mkdir()

    marker = target / "fan-delete-scope-marker" if target != Path(target.anchor) else None
    if marker is not None:
        marker.write_text("keep", encoding="utf-8")

    with pytest.raises(ValueError, match="not strictly under"):
        skills_sync._rmtree_writable(target)

    if marker is not None:
        assert marker.read_text(encoding="utf-8") == "keep"


def test_rmtree_writable_refuses_skills_root_itself(monkeypatch, tmp_path):
    skills_root = tmp_path / "fan-home" / "skills"
    keep = skills_root / "keep" / "SKILL.md"
    keep.parent.mkdir(parents=True)
    keep.write_text("keep", encoding="utf-8")
    monkeypatch.setattr(skills_sync, "SKILLS_DIR", skills_root)

    with pytest.raises(ValueError, match="not strictly under"):
        skills_sync._rmtree_writable(skills_root)

    assert keep.read_text(encoding="utf-8") == "keep"


def test_rmtree_writable_allows_strict_skill_subdirectory(monkeypatch, tmp_path):
    skills_root = tmp_path / "fan-home" / "skills"
    target = skills_root / "category" / "old-skill"
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text("old", encoding="utf-8")
    monkeypatch.setattr(skills_sync, "SKILLS_DIR", skills_root)

    skills_sync._rmtree_writable(target)

    assert skills_root.exists()
    assert not target.exists()


def test_rmtree_writable_refuses_symlink_escape(monkeypatch, tmp_path):
    skills_root = tmp_path / "fan-home" / "skills"
    outside = tmp_path / "outside"
    outside.mkdir(parents=True)
    marker = outside / "keep.txt"
    marker.write_text("keep", encoding="utf-8")
    _set_skills_root(monkeypatch, skills_root)
    escape = skills_root / "escape"
    escape.symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError, match="not strictly under"):
        skills_sync._rmtree_writable(escape)

    assert marker.read_text(encoding="utf-8") == "keep"
