"""Focused regression tests for build identity in ``fan dump``."""

import subprocess
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


def test_get_git_commit_date_uses_live_git(tmp_path):
    from fan_cli import dump

    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()
    result = MagicMock(returncode=0, stdout="2026-06-17\n")

    with patch("fan_cli.dump.subprocess.run", return_value=result):
        assert dump._get_git_commit_date(repo_dir) == "2026-06-17"


def test_get_git_commit_date_is_empty_when_git_returns_nonzero(tmp_path):
    from fan_cli import dump

    repo_dir = tmp_path / "not-a-repo"
    repo_dir.mkdir()
    result = MagicMock(returncode=128, stdout="")

    with patch("fan_cli.dump.subprocess.run", return_value=result):
        assert dump._get_git_commit_date(repo_dir) == ""


def test_get_git_commit_date_is_empty_when_git_is_missing(tmp_path):
    from fan_cli import dump

    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()

    with patch(
        "fan_cli.dump.subprocess.run",
        side_effect=FileNotFoundError("git"),
    ):
        assert dump._get_git_commit_date(repo_dir) == ""


def test_get_git_commit_date_is_empty_on_subprocess_error(tmp_path):
    from fan_cli import dump

    repo_dir = tmp_path / "repo"
    repo_dir.mkdir()

    with patch(
        "fan_cli.dump.subprocess.run",
        side_effect=subprocess.TimeoutExpired(["git", "log"], 5),
    ):
        assert dump._get_git_commit_date(repo_dir) == ""


def test_run_dump_uses_commit_date_instead_of_static_release_date(tmp_path, capsys):
    from fan_cli import dump

    with (
        patch("fan_cli.__version__", "9.9.9"),
        patch("fan_cli.__release_date__", "1900.1.1"),
        patch("fan_cli.dump.get_env_path", return_value=tmp_path / ".env"),
        patch("fan_cli.dump.get_project_root", return_value=tmp_path),
        patch("fan_cli.dump.get_fan_home", return_value=tmp_path / "fan-home"),
        patch("fan_cli.dump.load_fan_dotenv"),
        patch("fan_cli.dump.load_config", return_value={}),
        patch("fan_cli.dump.display_fan_home", return_value="~/.fan"),
        patch("fan_cli.dump._get_git_commit", return_value="deadbeef"),
        patch("fan_cli.dump._get_git_commit_date", return_value="2026-06-17"),
    ):
        dump.run_dump(SimpleNamespace(show_keys=False))

    output = capsys.readouterr().out
    assert "version:          9.9.9 [deadbeef] (2026-06-17)" in output
    assert "1900.1.1" not in output
