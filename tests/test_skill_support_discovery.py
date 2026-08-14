import json

from agent.skill_utils import (
    is_excluded_skill_path,
    is_skill_support_path,
    iter_skill_index_files,
)
from tools import skills_tool


def _write_skill(directory, name, body="Skill body"):
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "SKILL.md").write_text(
        "---\n"
        f"name: {name}\n"
        f"description: Description for {name}.\n"
        "---\n\n"
        f"{body}\n",
        encoding="utf-8",
    )


def test_skill_index_prunes_support_packages_but_keeps_named_categories(tmp_path):
    umbrella = tmp_path / "creative" / "umbrella"
    _write_skill(umbrella, "umbrella")
    archived = umbrella / "references" / "old-skill-package"
    _write_skill(archived, "old-skill")

    category_skill = tmp_path / "scripts" / "bash-helper"
    _write_skill(category_skill, "bash-helper")

    found = list(iter_skill_index_files(tmp_path, "SKILL.md"))

    assert found == [umbrella / "SKILL.md", category_skill / "SKILL.md"]
    assert is_skill_support_path(archived / "SKILL.md") is True
    assert is_excluded_skill_path(archived / "SKILL.md") is True
    assert is_skill_support_path(category_skill / "SKILL.md") is False


def test_support_markdown_does_not_shadow_real_skill(tmp_path, monkeypatch):
    skills_dir = tmp_path / "skills"
    article = skills_dir / "creative" / "article-illustrator"
    _write_skill(article, "article-illustrator")
    support = article / "references" / "styles" / "sketch.md"
    support.parent.mkdir(parents=True)
    support.write_text("# Supporting sketch style\n", encoding="utf-8")

    real = skills_dir / "creative" / "sketch"
    _write_skill(real, "sketch", body="REAL SKETCH SKILL")

    monkeypatch.setattr(skills_tool, "SKILLS_DIR", skills_dir)
    monkeypatch.setattr(
        "agent.skill_utils.get_external_skills_dirs", lambda: []
    )

    result = json.loads(skills_tool.skill_view("sketch", preprocess=False))

    assert result["success"] is True
    assert result["path"] == "creative/sketch/SKILL.md"
    assert "REAL SKETCH SKILL" in result["content"]
