from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from agent.tool_executor import _ensure_file_checkpoint


def test_relative_file_checkpoint_uses_task_resolved_path(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    resolved = workspace / "nested" / "target.txt"
    manager = MagicMock()
    manager.get_working_dir_for_path.return_value = str(workspace)
    observed = {}

    def resolve_path(path, task_id):
        observed.update(path=path, task_id=task_id)
        return resolved

    monkeypatch.setattr("tools.file_tools._resolve_path_for_task", resolve_path)

    _ensure_file_checkpoint(
        SimpleNamespace(_checkpoint_mgr=manager),
        "write_file",
        {"path": "nested/target.txt"},
        "desktop-session",
    )

    assert observed == {
        "path": "nested/target.txt",
        "task_id": "desktop-session",
    }
    manager.get_working_dir_for_path.assert_called_once_with(str(resolved))
    manager.ensure_checkpoint.assert_called_once_with(
        str(workspace),
        "before write_file",
    )
