from __future__ import annotations

from pathlib import Path

import pytest

from tools.environments.local import LocalEnvironment
from tools.file_operations import ShellFileOperations


@pytest.fixture
def ops(tmp_path: Path):
    return ShellFileOperations(LocalEnvironment(cwd=str(tmp_path)), cwd=str(tmp_path))


@pytest.mark.parametrize(
    ("name", "content"),
    [
        ("broken.json", '{"a": 1,'),
        ("broken.yaml", 'key: "unclosed\n'),
        ("broken.yml", 'key: "unclosed\n'),
        ("broken.toml", "[section\nvalue = 1"),
    ],
)
def test_invalid_structured_write_never_touches_disk(ops, tmp_path, name, content):
    target = tmp_path / name
    target.write_text("original", encoding="utf-8")
    result = ops.write_file(str(target), content)
    assert result.error is not None
    assert target.read_text(encoding="utf-8") == "original"


def test_invalid_new_structured_file_is_not_created(ops, tmp_path):
    target = tmp_path / "new.json"
    result = ops.write_file(str(target), "{")
    assert result.error is not None
    assert not target.exists()


@pytest.mark.parametrize(
    "content",
    [
        "apiVersion: v1\nkind: Namespace\n---\napiVersion: v1\nkind: ConfigMap\n",
        "BucketName: !Sub '${AWS::StackName}-bucket'\n",
    ],
)
def test_valid_extended_yaml_syntax_is_written(ops, tmp_path, content):
    target = tmp_path / "manifest.yaml"
    result = ops.write_file(str(target), content)
    assert result.error is None, result.error
    assert target.read_text(encoding="utf-8") == content


def test_invalid_python_remains_non_blocking_lint(ops, tmp_path):
    target = tmp_path / "partial.py"
    content = "def incomplete(:\n"
    result = ops.write_file(str(target), content)
    assert result.error is None
    assert target.read_text(encoding="utf-8") == content
    assert result.lint and result.lint.get("status") == "error"
